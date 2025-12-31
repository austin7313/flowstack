-- FlowStack Migration 001: Create Tables
-- PostgreSQL 14+

-- ============================================================================
-- BUSINESSES TABLE (Multi-tenant support)
-- ============================================================================
CREATE TABLE IF NOT EXISTS businesses (
    business_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_name VARCHAR(255) NOT NULL,
    whatsapp_number VARCHAR(20) UNIQUE NOT NULL,
    owner_phone VARCHAR(20) NOT NULL,
    industry VARCHAR(100),
    
    -- Configuration
    follow_up_rules JSONB DEFAULT '{
        "first_reminder_minutes": 120,
        "second_reminder_hours": 24,
        "dormant_days": 3,
        "payment_expiry_hours": 48
    }',
    
    message_templates JSONB DEFAULT '{
        "welcome": "welcome_template",
        "follow_up_2hr": "follow_up_gentle",
        "follow_up_24hr": "follow_up_reminder",
        "payment_reminder": "payment_pending",
        "payment_expired": "payment_expired"
    }',
    
    ai_enabled BOOLEAN DEFAULT false,
    ai_prompt TEXT,
    
    -- Billing
    subscription_status VARCHAR(20) DEFAULT 'trial',
    subscription_ends_at TIMESTAMP,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_businesses_whatsapp ON businesses(whatsapp_number);

-- ============================================================================
-- CONVERSATION STATES ENUM
-- ============================================================================
DO $$ BEGIN
    CREATE TYPE conversation_state AS ENUM (
        'NEW_LEAD',
        'ENGAGED',
        'AWAITING_CUSTOMER',
        'WAITING_FOR_PAYMENT',
        'PAID',
        'DORMANT',
        'ESCALATED',
        'CLOSED'
    );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ============================================================================
-- CONVERSATIONS TABLE (The State Machine Heart)
-- ============================================================================
CREATE TABLE IF NOT EXISTS conversations (
    conversation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
    
    customer_phone VARCHAR(20) NOT NULL,
    customer_name VARCHAR(255),
    
    -- State machine (CRITICAL)
    current_state conversation_state NOT NULL DEFAULT 'NEW_LEAD',
    previous_state conversation_state,
    state_changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Assignment
    assigned_staff_phone VARCHAR(20),
    assigned_staff_name VARCHAR(255),
    
    -- Activity tracking
    last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_customer_message_at TIMESTAMP,
    last_staff_reply_at TIMESTAMP,
    message_count INTEGER DEFAULT 0,
    
    -- Follow-up tracking
    follow_up_count INTEGER DEFAULT 0,
    last_follow_up_at TIMESTAMP,
    
    -- Metadata
    source VARCHAR(50) DEFAULT 'whatsapp',
    tags TEXT[],
    notes TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    closed_at TIMESTAMP,
    
    UNIQUE(business_id, customer_phone)
);

CREATE INDEX IF NOT EXISTS idx_conversations_business ON conversations(business_id);
CREATE INDEX IF NOT EXISTS idx_conversations_state ON conversations(current_state);
CREATE INDEX IF NOT EXISTS idx_conversations_customer ON conversations(customer_phone);

-- ============================================================================
-- PAYMENT INTENT STATUS ENUM
-- ============================================================================
DO $$ BEGIN
    CREATE TYPE payment_intent_status AS ENUM (
        'initiated',
        'pending',
        'paid',
        'failed',
        'expired'
    );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ============================================================================
-- PAYMENT PROVIDER ENUM
-- ============================================================================
DO $$ BEGIN
    CREATE TYPE payment_provider AS ENUM (
        'mpesa'
    );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ============================================================================
-- PAYMENT INTENTS TABLE (FIRST-CLASS ENTITY)
-- ============================================================================
CREATE TABLE IF NOT EXISTS payment_intents (
    payment_intent_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
    business_id UUID NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
    
    -- Payment details
    expected_amount DECIMAL(10, 2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'KES',
    description TEXT,
    
    -- Status (INTERNAL AUTHORITY)
    status payment_intent_status NOT NULL DEFAULT 'initiated',
    
    -- Provider (CONNECTOR ONLY)
    provider payment_provider NOT NULL DEFAULT 'mpesa',
    provider_reference VARCHAR(255),
    provider_transaction_id VARCHAR(255),
    provider_metadata JSONB,
    
    -- Lifecycle
    expires_at TIMESTAMP NOT NULL,
    paid_at TIMESTAMP,
    failed_at TIMESTAMP,
    failure_reason TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payment_intents_conversation ON payment_intents(conversation_id);
CREATE INDEX IF NOT EXISTS idx_payment_intents_business ON payment_intents(business_id);
CREATE INDEX IF NOT EXISTS idx_payment_intents_status ON payment_intents(status);
CREATE INDEX IF NOT EXISTS idx_payment_intents_provider_ref ON payment_intents(provider_reference);
CREATE INDEX IF NOT EXISTS idx_payment_intents_expires ON payment_intents(expires_at) 
    WHERE status IN ('initiated', 'pending');

-- ============================================================================
-- LEAD STATUS ENUM
-- ============================================================================
DO $$ BEGIN
    CREATE TYPE lead_status AS ENUM (
        'new',
        'engaged',
        'paid',
        'dormant',
        'lost'
    );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ============================================================================
-- LEADS TABLE (Sales tracking)
-- ============================================================================
CREATE TABLE IF NOT EXISTS leads (
    lead_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES conversations(conversation_id) ON DELETE CASCADE,
    business_id UUID NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
    
    customer_phone VARCHAR(20) NOT NULL,
    customer_name VARCHAR(255),
    
    service_requested TEXT,
    status lead_status NOT NULL DEFAULT 'new',
    value_estimate DECIMAL(10, 2),
    
    -- Journey tracking
    first_contact_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_interaction_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    converted_at TIMESTAMP,
    lost_at TIMESTAMP,
    lost_reason TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_leads_business ON leads(business_id);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_customer ON leads(customer_phone);

-- ============================================================================
-- MESSAGES TABLE (Conversation history)
-- ============================================================================
CREATE TABLE IF NOT EXISTS messages (
    message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
    business_id UUID NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
    
    direction VARCHAR(10) NOT NULL,
    sender_phone VARCHAR(20) NOT NULL,
    sender_name VARCHAR(255),
    
    message_body TEXT NOT NULL,
    media_url TEXT,
    media_type VARCHAR(50),
    
    -- Composition metadata
    template_key VARCHAR(100),
    composition_context JSONB,
    
    -- WhatsApp metadata
    whatsapp_message_id VARCHAR(255),
    whatsapp_status VARCHAR(20),
    
    -- AI metadata
    generated_by_ai BOOLEAN DEFAULT false,
    
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    delivered_at TIMESTAMP,
    read_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_business ON messages(business_id);
CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages(sent_at DESC);

-- ============================================================================
-- TASK STATUS ENUM
-- ============================================================================
DO $$ BEGIN
    CREATE TYPE task_status AS ENUM (
        'pending',
        'completed',
        'failed',
        'escalated',
        'cancelled'
    );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ============================================================================
-- FOLLOW_UP_TASKS TABLE (The automation engine)
-- ============================================================================
CREATE TABLE IF NOT EXISTS follow_up_tasks (
    task_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
    business_id UUID NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
    payment_intent_id UUID REFERENCES payment_intents(payment_intent_id) ON DELETE SET NULL,
    
    -- Trigger info
    trigger_reason VARCHAR(100) NOT NULL,
    scheduled_time TIMESTAMP NOT NULL,
    
    -- Execution
    status task_status NOT NULL DEFAULT 'pending',
    executed_at TIMESTAMP,
    
    -- Message details
    message_template_key VARCHAR(100) NOT NULL,
    message_context JSONB,
    message_body TEXT,
    message_sent BOOLEAN DEFAULT false,
    whatsapp_message_id VARCHAR(255),
    
    -- Escalation
    escalation_level INTEGER DEFAULT 1,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_follow_up_pending ON follow_up_tasks(scheduled_time, status) 
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_follow_up_conversation ON follow_up_tasks(conversation_id);
CREATE INDEX IF NOT EXISTS idx_follow_up_business ON follow_up_tasks(business_id);
CREATE INDEX IF NOT EXISTS idx_follow_up_payment ON follow_up_tasks(payment_intent_id);

-- ============================================================================
-- STATE_TRANSITIONS TABLE (Audit log)
-- ============================================================================
CREATE TABLE IF NOT EXISTS state_transitions (
    transition_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
    business_id UUID NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
    
    from_state conversation_state NOT NULL,
    to_state conversation_state NOT NULL,
    
    trigger VARCHAR(100) NOT NULL,
    triggered_by VARCHAR(255),
    
    metadata JSONB,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_state_transitions_conversation ON state_transitions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_state_transitions_business ON state_transitions(business_id);
CREATE INDEX IF NOT EXISTS idx_state_transitions_created ON state_transitions(created_at DESC);

-- ============================================================================
-- EVENTS TABLE (Event sourcing)
-- ============================================================================
CREATE TABLE IF NOT EXISTS events (
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES conversations(conversation_id) ON DELETE CASCADE,
    payment_intent_id UUID REFERENCES payment_intents(payment_intent_id) ON DELETE CASCADE,
    
    event_type VARCHAR(100) NOT NULL,
    payload JSONB,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_events_business ON events(business_id);
CREATE INDEX IF NOT EXISTS idx_events_conversation ON events(conversation_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
