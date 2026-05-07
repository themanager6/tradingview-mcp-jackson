/**
 * Core alert logic.
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

export async function create({ condition, price, message }) {
  const opened = await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Create Alert"]')
        || document.querySelector('[data-name="alerts"]');
      if (btn) { btn.click(); return true; }
      return false;
    })()
  `);

  if (!opened) {
    const client = await getClient();
    await client.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 1, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA' });
  }

  await new Promise(r => setTimeout(r, 1000));

  const priceSet = await evaluate(`
    (function() {
      var inputs = document.querySelectorAll('[class*="alert"] input[type="text"], [class*="alert"] input[type="number"]');
      for (var i = 0; i < inputs.length; i++) {
        var label = inputs[i].closest('[class*="row"]')?.querySelector('[class*="label"]');
        if (label && /value|price/i.test(label.textContent)) {
          var nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          nativeSet.call(inputs[i], '${price}');
          inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      if (inputs.length > 0) {
        var nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSet.call(inputs[0], '${price}');
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      return false;
    })()
  `);

  if (message) {
    await evaluate(`
      (function() {
        var textarea = document.querySelector('[class*="alert"] textarea')
          || document.querySelector('textarea[placeholder*="message"]');
        if (textarea) {
          var nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          nativeSet.call(textarea, ${JSON.stringify(message)});
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
      })()
    `);
  }

  await new Promise(r => setTimeout(r, 500));
  const created = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button[data-name="submit"], button');
      for (var i = 0; i < btns.length; i++) {
        if (/^create$/i.test(btns[i].textContent.trim())) { btns[i].click(); return true; }
      }
      return false;
    })()
  `);

  return { success: !!created, price, condition, message: message || '(none)', price_set: !!priceSet, source: 'dom_fallback' };
}

export async function list() {
  // Use pricealerts REST API — returns structured data with alert_id, symbol, price, conditions
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.s !== 'ok' || !Array.isArray(data.r)) return { alerts: [], error: data.errmsg || 'Unexpected response' };
        return {
          alerts: data.r.map(function(a) {
            var sym = '';
            try { sym = JSON.parse(a.symbol.replace(/^=/, '')).symbol || a.symbol; } catch(e) { sym = a.symbol; }
            return {
              alert_id: a.alert_id,
              symbol: sym,
              type: a.type,
              message: a.message,
              active: a.active,
              condition: a.condition,
              resolution: a.resolution,
              created: a.create_time,
              last_fired: a.last_fire_time,
              expiration: a.expiration,
            };
          })
        };
      })
      .catch(function(e) { return { alerts: [], error: e.message }; })
  `);
  return { success: true, alert_count: result?.alerts?.length || 0, source: 'internal_api', alerts: result?.alerts || [], error: result?.error };
}

/**
 * Update an existing alert subscription's message field.
 *
 * Pre-condition: the TV Alerts panel must be open in the right widget bar so that
 * the virtual list is mounted and we can read items[] from the React fiber.
 *
 * Idempotent: if the alert's current message already starts with '{', the function
 * returns action="skipped" with reason="already_json" and does NOT overwrite.
 *
 * Handles BOTH UI editor variants TV uses for the message field:
 *   - inline: textarea expands inside the parent edit-alert dialog
 *   - modal:  separate [data-qa-id="alerts-message-edit-dialog"] popup
 *
 * @param {Object} args
 * @param {number} args.alert_id - TV alert subscription id (from alert_list)
 * @param {string} args.new_message - New message string (placeholders like {{ticker}} preserved)
 * @returns {Promise<Object>} { success, alert_id, action: "updated"|"skipped"|"failed", ... }
 */
export async function updateMessage({ alert_id, new_message }) {
  if (typeof alert_id !== 'number' || !Number.isFinite(alert_id)) {
    return { success: false, error: 'alert_id must be a finite number', alert_id };
  }
  if (typeof new_message !== 'string' || new_message.length === 0) {
    return { success: false, error: 'new_message must be a non-empty string', alert_id };
  }

  // Step 1: stash items + callbacks from the alerts virtual list.
  const stashRes = await evaluate(`
    (function stash() {
      const desc = document.querySelector('[data-name="alert-item-description"]');
      if (!desc) return { error: 'no alert-item-description — open the Alerts panel first' };
      const fk = Object.keys(desc).find(k => k.startsWith('__reactFiber$'));
      if (!fk) return { error: 'no react fiber on description' };
      let walker = desc[fk];
      for (let d = 0; d < 30; d++) {
        if (!walker) break;
        const mp = walker.memoizedProps;
        if (mp && mp.itemCount && mp.itemData && Array.isArray(mp.itemData.items)) {
          window.__efCallbacks = mp.itemData.callbacks;
          window.__efItems = mp.itemData.items;
          return { stashed: true, items_count: mp.itemData.items.length };
        }
        walker = walker.return;
      }
      return { error: 'virtual list not found' };
    })()
  `);
  if (!stashRes || stashRes.error) {
    return { success: false, error: stashRes?.error || 'stash failed', alert_id };
  }

  // Step 2: defensively clear search filter (it can hide alerts from items[]).
  const clearRes = await evaluate(`
    (function clearSearch() {
      const search = document.querySelector('input[type="search"], input[placeholder*="earch" i]');
      if (!search) return { cleared: false };
      const before = search.value;
      if (before === '') return { was_empty: true };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(search, '');
      search.dispatchEvent(new Event('input', { bubbles: true }));
      search.dispatchEvent(new Event('change', { bubbles: true }));
      return { cleared: true, before_value: before };
    })()
  `);
  let itemsCount = stashRes.items_count;
  if (clearRes?.cleared && clearRes.before_value) {
    // Re-stash after debounce
    const restash = await evaluateAsync(`
      (async function restash() {
        await new Promise(r => setTimeout(r, 800));
        const desc = document.querySelector('[data-name="alert-item-description"]');
        if (!desc) return { error: 'no description after restash' };
        const fk = Object.keys(desc).find(k => k.startsWith('__reactFiber$'));
        let walker = desc[fk];
        for (let d = 0; d < 30; d++) {
          if (!walker) break;
          const mp = walker.memoizedProps;
          if (mp && mp.itemCount && mp.itemData && Array.isArray(mp.itemData.items)) {
            window.__efCallbacks = mp.itemData.callbacks;
            window.__efItems = mp.itemData.items;
            return { restashed: true, items_count: mp.itemData.items.length };
          }
          walker = walker.return;
        }
        return { error: 'virtual list not found after restash' };
      })()
    `);
    if (!restash || restash.error) {
      return { success: false, error: 'restash after search-clear failed: ' + (restash?.error || ''), alert_id };
    }
    itemsCount = restash.items_count;
  }

  // Step 3: run the per-alert update sequence.
  const newMessageEscaped = JSON.stringify(new_message);
  const updateExpr = `
    (async function updateOne() {
      const items = window.__efItems;
      const callbacks = window.__efCallbacks;
      if (!items || !callbacks) return { error: 'stash missing' };

      const idx = items.findIndex(it => it.id === ${alert_id});
      if (idx < 0) return { error: 'alert_id not found in items', alert_id: ${alert_id}, items_total: items.length };

      // 1. Open the dialog
      callbacks.onEditButtonClick(idx);
      let dialog = null;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 50));
        dialog = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
        if (dialog && dialog.offsetWidth) break;
      }
      if (!dialog || !dialog.offsetWidth) return { error: 'dialog did not appear', alert_id: ${alert_id} };

      // 2. Capture current message
      const msgBtn = dialog.querySelector('[data-qa-id="alert-message-button"]');
      if (!msgBtn) return { error: 'no alert-message-button', alert_id: ${alert_id} };
      const oldMessage = (msgBtn.getAttribute('data-overflow-tooltip-html') || msgBtn.textContent || '').trim();

      // Idempotency: skip if already JSON
      if (oldMessage.startsWith('{')) {
        const cancel = dialog.querySelector('[data-qa-id="cancel"]');
        if (cancel) {
          const pk = Object.keys(cancel).find(k => k.startsWith('__reactProps$'));
          if (pk && cancel[pk].onClick) {
            cancel[pk].onClick({ preventDefault: () => {}, stopPropagation: () => {}, currentTarget: cancel, target: cancel, nativeEvent: {} });
          }
        }
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 50));
          const still = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
          if (!still || !still.offsetWidth) break;
        }
        return { skipped: true, reason: 'already_json', alert_id: ${alert_id}, current_message_preview: oldMessage.substring(0, 120) };
      }

      // 3. Click message button to open the editor (inline OR modal)
      const msgPK = Object.keys(msgBtn).find(k => k.startsWith('__reactProps$'));
      if (!msgPK || !msgBtn[msgPK].onClick) return { error: 'no onClick on alert-message-button', alert_id: ${alert_id} };
      msgBtn[msgPK].onClick({ preventDefault: () => {}, stopPropagation: () => {}, currentTarget: msgBtn, target: msgBtn, nativeEvent: {} });

      // 4. Wait for textarea
      let ta = null;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 50));
        ta = document.querySelector('#alert-message');
        if (ta && ta.offsetWidth) break;
      }
      if (!ta || !ta.offsetWidth) return { error: 'textarea did not appear', alert_id: ${alert_id} };

      // 5. Set new value
      const newMsg = ${newMessageEscaped};
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, newMsg);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 100));
      if (ta.value !== newMsg) return { error: 'value did not stick', alert_id: ${alert_id} };

      // 6. Click Apply (modal's submit if modal open, else parent's submit)
      const messageModal = document.querySelector('[data-qa-id="alerts-message-edit-dialog"]');
      const editorRoot = messageModal || dialog;
      const usingModal = !!messageModal;
      const apply = editorRoot.querySelector('[data-qa-id="submit"]');
      if (!apply) return { error: 'no submit (apply) in editor root', alert_id: ${alert_id}, modal: usingModal };
      const applyPK = Object.keys(apply).find(k => k.startsWith('__reactProps$'));
      if (!applyPK || !apply[applyPK].onClick) return { error: 'no onClick on apply', alert_id: ${alert_id} };
      apply[applyPK].onClick({ preventDefault: () => {}, stopPropagation: () => {}, currentTarget: apply, target: apply, nativeEvent: {} });

      // 7. Wait for editor to close
      let editorClosed = false;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 50));
        if (usingModal) {
          const stillModal = document.querySelector('[data-qa-id="alerts-message-edit-dialog"]');
          if (!stillModal || !stillModal.offsetWidth) { editorClosed = true; break; }
        } else {
          const stillTa = document.querySelector('#alert-message');
          if (!stillTa || !stillTa.offsetWidth) { editorClosed = true; break; }
        }
      }
      if (!editorClosed) return { error: 'editor did not close after apply', alert_id: ${alert_id}, ui_path: usingModal ? 'modal' : 'inline' };

      // 8. Sanity: parent's message-button now shows the new message
      const msgBtnAfter = dialog.querySelector('[data-qa-id="alert-message-button"]');
      const msgBtnText = msgBtnAfter ? (msgBtnAfter.textContent || '').trim() : '';
      if (!msgBtnText.startsWith('{')) {
        return { error: 'message-button does not show new JSON after apply', alert_id: ${alert_id}, msg_btn_text_preview: msgBtnText.substring(0, 100) };
      }

      // 9. Click Save on parent
      await new Promise(r => setTimeout(r, 100));
      const save = dialog.querySelector('[data-qa-id="submit"]');
      if (!save) return { error: 'no save button in parent', alert_id: ${alert_id} };
      const saveText = (save.textContent || '').trim();
      if (saveText !== 'Save') return { error: 'parent submit text is not Save', alert_id: ${alert_id}, save_text: saveText };
      const savePK = Object.keys(save).find(k => k.startsWith('__reactProps$'));
      if (!savePK || !save[savePK].onClick) return { error: 'no onClick on save', alert_id: ${alert_id} };
      save[savePK].onClick({ preventDefault: () => {}, stopPropagation: () => {}, currentTarget: save, target: save, nativeEvent: {} });

      // 10. Wait for parent dialog to close
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 50));
        const still = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
        if (!still || !still.offsetWidth) {
          return { updated: true, alert_id: ${alert_id}, old_message: oldMessage.substring(0, 250), new_message: newMsg, ui_path: usingModal ? 'modal' : 'inline' };
        }
      }
      return { error: 'dialog did not close after save', alert_id: ${alert_id}, ui_path: usingModal ? 'modal' : 'inline' };
    })()
  `;

  const res = await evaluateAsync(updateExpr);

  if (!res) {
    return { success: false, error: 'no result from update sequence', alert_id };
  }
  if (res.skipped) {
    return { success: true, action: 'skipped', alert_id, reason: res.reason, current_message_preview: res.current_message_preview, items_count: itemsCount };
  }
  if (res.updated) {
    return { success: true, action: 'updated', alert_id, old_message: res.old_message, new_message: res.new_message, ui_path: res.ui_path, items_count: itemsCount };
  }
  return { success: false, action: 'failed', alert_id, error: res.error || 'unknown failure', detail: res, items_count: itemsCount };
}

export async function deleteAlerts({ delete_all }) {
  if (delete_all) {
    const result = await evaluate(`
      (function() {
        var alertBtn = document.querySelector('[data-name="alerts"]');
        if (alertBtn) alertBtn.click();
        var header = document.querySelector('[data-name="alerts"]');
        if (header) {
          header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
          return { context_menu_opened: true };
        }
        return { context_menu_opened: false };
      })()
    `);
    return { success: true, note: 'Alert deletion requires manual confirmation in the context menu.', context_menu_opened: result?.context_menu_opened || false, source: 'dom_fallback' };
  }
  throw new Error('Individual alert deletion not yet supported. Use delete_all: true.');
}
