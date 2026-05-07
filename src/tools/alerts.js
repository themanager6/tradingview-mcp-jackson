import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server) {
  server.tool('alert_create', 'Create a price alert via the TradingView alert dialog', {
    condition: z.string().describe('Alert condition (e.g., "crossing", "greater_than", "less_than")'),
    price: z.coerce.number().describe('Price level for the alert'),
    message: z.string().optional().describe('Alert message'),
  }, async ({ condition, price, message }) => {
    try { return jsonResult(await core.create({ condition, price, message })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_list', 'List active alerts', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_delete', 'Delete all alerts or open context menu for deletion', {
    delete_all: z.coerce.boolean().optional().describe('Delete all alerts'),
  }, async ({ delete_all }) => {
    try { return jsonResult(await core.deleteAlerts({ delete_all })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_update_message', 'Update the message field on an existing alert subscription. Idempotent: skips if current message already starts with "{". Pre-condition: TV Alerts panel must be open in the right widget bar. Handles both inline and modal message-editor UI variants.', {
    alert_id: z.coerce.number().describe('TV alert subscription id (from alert_list)'),
    new_message: z.string().describe('New message string. Pine placeholders like {{ticker}}, {{close}}, {{time}}, {{plot("...")}} are preserved literally.'),
  }, async ({ alert_id, new_message }) => {
    try { return jsonResult(await core.updateMessage({ alert_id, new_message })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
