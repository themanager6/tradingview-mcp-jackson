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

  server.tool('alert_update_message', 'Update the message field on an existing alert subscription. Idempotent by default: skips if current message already starts with "{". Pass force_overwrite=true to bypass that guard (e.g. when adding fields to an existing JSON message). Pre-condition: TV Alerts panel must be open in the right widget bar. Handles both inline and modal message-editor UI variants.', {
    alert_id: z.coerce.number().describe('TV alert subscription id (from alert_list)'),
    new_message: z.string().describe('New message string. Pine placeholders like {{ticker}}, {{close}}, {{time}}, {{plot("...")}} are preserved literally.'),
    force_overwrite: z.boolean().optional().default(false).describe('When true, bypass the "skip if already JSON" idempotency guard. Required for Phase 4d: adding signal_kind to existing JSON alerts. Default false preserves the safe behavior.'),
  }, async ({ alert_id, new_message, force_overwrite }) => {
    try { return jsonResult(await core.updateMessage({ alert_id, new_message, force_overwrite })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_update_webhook_url', 'Update the webhook URL on an existing alert subscription. Idempotent: skips if current URL already matches new_url AND webhook toggle is enabled. Handles toggle-off state by enabling webhook checkbox first (polls 500ms for input to become enabled). Pre-condition: TV Alerts panel must be open in the right widget bar.', {
    alert_id: z.coerce.number().describe('TV alert subscription id (from alert_list)'),
    new_url: z.string().describe('New webhook URL. Must include scheme (http:// or https://).'),
  }, async ({ alert_id, new_url }) => {
    try { return jsonResult(await core.updateWebhookUrl({ alert_id, new_url })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_delete_one', 'Delete a single alert subscription by alert_id. Idempotent: returns action="not_found" if alert is already gone (REST verified). Verifies dialog content matches expected message before deleting (guards against items[]-vs-callback drift). Handles both confirmation-modal and direct-delete paths. Pre-condition: TV Alerts panel must be open in the right widget bar.', {
    alert_id: z.coerce.number().describe('TV alert subscription id (from alert_list). Use this for surgical per-alert delete; for sweep-everything use alert_delete with delete_all=true.'),
  }, async ({ alert_id }) => {
    try { return jsonResult(await core.deleteAlert({ alert_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
