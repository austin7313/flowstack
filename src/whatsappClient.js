/**
 * WhatsApp Client
 * Abstraction layer for WhatsApp Cloud API
 */

class WhatsAppClient {
  constructor(config) {
    this.config = config;
    this.phoneNumberId = config.WHATSAPP_PHONE_NUMBER_ID;
    this.accessToken = config.WHATSAPP_ACCESS_TOKEN;
    this.verifyToken = config.WHATSAPP_VERIFY_TOKEN;
  }

  /**
   * Send a text message via WhatsApp
   */
  async sendMessage({ from, to, body, mediaUrl = null }) {
    try {
      // TODO: Implement Meta Cloud API call
      // Example for Meta Cloud API:
      /*
      const response = await fetch(
        `https://graph.facebook.com/v18.0/${this.phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: to,
            type: 'text',
            text: { body }
          } )
        }
      );
      
      if (!response.ok) {
        throw new Error(`WhatsApp API error: ${response.statusText}`);
      }
      
      const data = await response.json();
      return {
        success: true,
        messageId: data.messages[0].id
      };
      */

      console.log(`[WhatsApp] ${from} → ${to}: ${body}`);
      return { success: true, messageId: 'MOCK_MESSAGE_ID' };
    } catch (error) {
      console.error('WhatsApp send error:', error);
      throw error;
    }
  }

  /**
   * Verify webhook token
   */
  verifyWebhook(token) {
    return token === this.verifyToken;
  }

  /**
   * Parse incoming message from webhook
   */
  parseIncomingMessage(webhookData) {
    const { entry } = webhookData;
    const messages = [];

    for (const item of entry) {
      const changes = item.changes || [];
      for (const change of changes) {
        if (change.value.messages) {
          for (const message of change.value.messages) {
            messages.push({
              from: message.from,
              to: change.value.metadata.phone_number_id,
              body: message.text?.body || '',
              messageId: message.id,
              timestamp: message.timestamp,
              type: message.type
            });
          }
        }
      }
    }

    return messages;
  }
}

module.exports = WhatsAppClient;
