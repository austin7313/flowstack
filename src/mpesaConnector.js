/**
 * M-Pesa Connector
 * Integration with M-Pesa Daraja API
 */

const axios = require('axios');
const db = require('./db');

class MPesaConnector {
  constructor(config, paymentEngine) {
    this.config = config;
    this.paymentEngine = paymentEngine;
    this.consumerKey = config.MPESA_CONSUMER_KEY;
    this.consumerSecret = config.MPESA_CONSUMER_SECRET;
    this.shortcode = config.MPESA_SHORTCODE;
    this.passkey = config.MPESA_PASSKEY;
    this.environment = config.MPESA_ENVIRONMENT || 'sandbox';
    this.baseUrl = this.environment === 'production'
      ? 'https://api.safaricom.co.ke'
      : 'https://sandbox.safaricom.co.ke';
  }

  /**
   * Get OAuth token from M-Pesa
   */
  async getAccessToken( ) {
    try {
      const auth = Buffer.from(`${this.consumerKey}:${this.consumerSecret}`).toString('base64');
      
      const response = await axios.get(
        `${this.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
        {
          headers: {
            'Authorization': `Basic ${auth}`
          }
        }
      );

      return response.data.access_token;
    } catch (error) {
      console.error('M-Pesa token error:', error.message);
      throw error;
    }
  }

  /**
   * Initiate STK Push (Lipa na M-Pesa Online)
   */
  async initiatePayment(paymentIntentId, phoneNumber, amount) {
    try {
      const token = await this.getAccessToken();
      const timestamp = new Date().toISOString().replace(/[:-]/g, '').slice(0, -5);
      const password = Buffer.from(`${this.shortcode}${this.passkey}${timestamp}`).toString('base64');

      const response = await axios.post(
        `${this.baseUrl}/mpesa/stkpush/v1/processrequest`,
        {
          BusinessShortCode: this.shortcode,
          Password: password,
          Timestamp: timestamp,
          TransactionType: 'CustomerPayBillOnline',
          Amount: Math.ceil(amount),
          PartyA: phoneNumber,
          PartyB: this.shortcode,
          PhoneNumber: phoneNumber,
          CallBackURL: `${process.env.CALLBACK_URL}/webhooks/mpesa`,
          AccountReference: paymentIntentId,
          TransactionDesc: 'Payment for services'
        },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data.ResponseCode === '0') {
        console.log(`✓ STK push initiated: ${paymentIntentId}`);
        
        // Store checkout request ID
        await db.query(
          `UPDATE payment_intents 
           SET provider_reference = $1 
           WHERE payment_intent_id = $2`,
          [response.data.CheckoutRequestID, paymentIntentId]
        );

        return response.data.CheckoutRequestID;
      } else {
        throw new Error(`M-Pesa error: ${response.data.ResponseDescription}`);
      }
    } catch (error) {
      console.error('STK push error:', error.message);
      throw error;
    }
  }

  /**
   * Handle M-Pesa callback
   */
  async handleCallback(callback) {
    try {
      const { Body } = callback;
      const stkCallback = Body.stkCallback;
      
      const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = stkCallback;

      if (ResultCode === 0) {
        // Payment successful
        const metadata = {};
        
        if (CallbackMetadata && CallbackMetadata.Item) {
          for (const item of CallbackMetadata.Item) {
            metadata[item.Name] = item.Value;
          }
        }

        // Find payment intent by provider reference
        const result = await db.query(
          `SELECT payment_intent_id FROM payment_intents 
           WHERE provider_reference = $1`,
          [CheckoutRequestID]
        );

        if (result.rows.length > 0) {
          const paymentIntentId = result.rows[0].payment_intent_id;
          
          // Update payment intent
          await this.paymentEngine.updateStatus(
            paymentIntentId,
            'paid',
            {
              provider_transaction_id: metadata.MpesaReceiptNumber,
              provider_metadata: JSON.stringify(metadata)
            }
          );

          console.log(`✓ Payment confirmed: ${paymentIntentId}`);
        }
      } else {
        console.log(`Payment failed: ${ResultDesc} (Code: ${ResultCode})`);
        
        // Handle failed payment
        const result = await db.query(
          `SELECT payment_intent_id FROM payment_intents 
           WHERE provider_reference = $1`,
          [CheckoutRequestID]
        );

        if (result.rows.length > 0) {
          const paymentIntentId = result.rows[0].payment_intent_id;
          
          await this.paymentEngine.updateStatus(
            paymentIntentId,
            'failed',
            { failure_reason: ResultDesc }
          );
        }
      }
    } catch (error) {
      console.error('M-Pesa callback error:', error.message);
      throw error;
    }
  }

  /**
   * Query payment status
   */
  async queryPaymentStatus(checkoutRequestID) {
    try {
      const token = await this.getAccessToken();
      const timestamp = new Date().toISOString().replace(/[:-]/g, '').slice(0, -5);
      const password = Buffer.from(`${this.shortcode}${this.passkey}${timestamp}`).toString('base64');

      const response = await axios.post(
        `${this.baseUrl}/mpesa/stkpushquery/v1/query`,
        {
          BusinessShortCode: this.shortcode,
          Password: password,
          Timestamp: timestamp,
          CheckoutRequestID: checkoutRequestID
        },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return response.data;
    } catch (error) {
      console.error('Query status error:', error.message);
      throw error;
    }
  }
}

module.exports = MPesaConnector;
