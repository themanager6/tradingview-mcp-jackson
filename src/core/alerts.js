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
export async function updateMessage({ alert_id, new_message, force_overwrite = false }) {
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

      // Idempotency: skip if already JSON. Bypassed when force_overwrite=true
      // (e.g. Phase 4d adding signal_kind to existing JSON alerts).
      if (oldMessage.startsWith('{') && !${force_overwrite}) {
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
    return { success: true, action: 'updated', alert_id, old_message: res.old_message, new_message: res.new_message, ui_path: res.ui_path, items_count: itemsCount, forced: !!force_overwrite };
  }
  return { success: false, action: 'failed', alert_id, error: res.error || 'unknown failure', detail: res, items_count: itemsCount };
}

/**
 * Update the webhook URL on an existing alert subscription.
 *
 * Pre-condition: TV Alerts panel must be open in the right widget bar so
 * the virtual list is mounted (same as updateMessage).
 *
 * Idempotent: if the alert's current webhook URL already equals new_url AND
 * the webhook toggle is enabled, returns action="skipped" with
 * reason="already_set" and DOES NOT overwrite (cancels both modal + dialog
 * cleanly without saving).
 *
 * Handles:
 *   - Webhook toggle OFF (common case for first-time enable): clicks the
 *     toggle checkbox, polls 25ms × 20 = 500ms for the URL input to become
 *     enabled, then sets the value.
 *   - Webhook toggle ON with different URL: just overwrites the value.
 *   - Webhook toggle ON with same URL: skipped (idempotency).
 *
 * Save flow: modal "Apply" → returns to outer create-edit dialog → outer
 * "Save" persists the change to TV's alert subscription store. If the outer
 * Save click does not close the dialog within ~2s, returns
 * action="failed" with error="outer_save_failed_after_modal_apply" — the
 * bulk caller logs and re-runs from the failure log; idempotency makes
 * re-runs safe regardless of whether the slow Save actually persisted.
 *
 * @param {Object} args
 * @param {number} args.alert_id - TV alert subscription id (from alert_list)
 * @param {string} args.new_url - New webhook URL (must include scheme)
 * @returns {Promise<Object>} { success, action: "updated"|"skipped"|"failed", alert_id, ... }
 */
export async function updateWebhookUrl({ alert_id, new_url }) {
  if (typeof alert_id !== 'number' || !Number.isFinite(alert_id)) {
    return { success: false, error: 'alert_id must be a finite number', alert_id };
  }
  if (typeof new_url !== 'string' || new_url.length === 0) {
    return { success: false, error: 'new_url must be a non-empty string', alert_id };
  }
  if (!/^https?:\/\//i.test(new_url)) {
    return { success: false, error: 'new_url must start with http:// or https://', alert_id };
  }

  // Step A: stash items + callbacks (mirror updateMessage).
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

  // Step B: defensively clear search filter (same as updateMessage).
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

  // Step C: per-alert update sequence.
  const newUrlEscaped = JSON.stringify(new_url);
  const updateExpr = `
    (async function updateOne() {
      const items = window.__efItems;
      const callbacks = window.__efCallbacks;
      if (!items || !callbacks) return { error: 'stash missing' };

      const idx = items.findIndex(it => it.id === ${alert_id});
      if (idx < 0) return { error: 'alert_id not found in items', alert_id: ${alert_id}, items_total: items.length };

      // Helper: cancel any open modal then any open dialog. Used on every
      // failure path so a stuck UI doesn't poison the next call.
      async function cleanCancel() {
        const modal = document.querySelector('[data-qa-id="alerts-notifications-edit-dialog"]');
        if (modal && modal.offsetWidth) {
          const c = modal.querySelector('[data-qa-id="cancel"]');
          if (c) {
            const pk = Object.keys(c).find(k => k.startsWith('__reactProps$'));
            if (pk && c[pk].onClick) c[pk].onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, currentTarget: c, target: c, nativeEvent: {} });
          }
          for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 50));
            const m = document.querySelector('[data-qa-id="alerts-notifications-edit-dialog"]');
            if (!m || !m.offsetWidth) break;
          }
        }
        const dlg = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
        if (dlg && dlg.offsetWidth) {
          const c = dlg.querySelector('[data-qa-id="cancel"]');
          if (c) {
            const pk = Object.keys(c).find(k => k.startsWith('__reactProps$'));
            if (pk && c[pk].onClick) c[pk].onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, currentTarget: c, target: c, nativeEvent: {} });
          }
          for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 50));
            const d = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
            if (!d || !d.offsetWidth) break;
          }
        }
      }

      // 1. Open the outer create-edit dialog.
      callbacks.onEditButtonClick(idx);
      let dialog = null;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 50));
        dialog = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
        if (dialog && dialog.offsetWidth) break;
      }
      if (!dialog || !dialog.offsetWidth) return { error: 'dialog did not appear', alert_id: ${alert_id} };

      // 2. Click the notifications fieldset's button to open the modal.
      const notifBtn = dialog.querySelector('[data-qa-id="alert-notifications-button"]');
      if (!notifBtn) { await cleanCancel(); return { error: 'no alert-notifications-button', alert_id: ${alert_id} }; }
      const notifPK = Object.keys(notifBtn).find(k => k.startsWith('__reactProps$'));
      if (!notifPK || !notifBtn[notifPK].onClick) { await cleanCancel(); return { error: 'no onClick on alert-notifications-button', alert_id: ${alert_id} }; }
      notifBtn[notifPK].onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, currentTarget: notifBtn, target: notifBtn, nativeEvent: {} });

      // 3. Wait for the notifications modal to render.
      let modal = null;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 50));
        modal = document.querySelector('[data-qa-id="alerts-notifications-edit-dialog"]');
        if (modal && modal.offsetWidth) break;
      }
      if (!modal || !modal.offsetWidth) { await cleanCancel(); return { error: 'notifications modal did not appear', alert_id: ${alert_id} }; }

      // 4. Read current webhook state.
      const urlInput = modal.querySelector('[data-qa-id="ui-lib-Input-input webhook-input-input"]');
      if (!urlInput) { await cleanCancel(); return { error: 'webhook URL input not found in modal', alert_id: ${alert_id} }; }
      const oldUrl = urlInput.value || '';
      const wasDisabled = !!urlInput.disabled;

      // 5. Idempotency check: if URL matches AND toggle is on (input enabled),
      //    cancel both layers and return skipped.
      const newUrl = ${newUrlEscaped};
      if (oldUrl === newUrl && !wasDisabled) {
        await cleanCancel();
        return { skipped: true, reason: 'already_set', alert_id: ${alert_id}, current_url: oldUrl };
      }

      // 6. If toggle OFF, flip via native checked-setter + dispatch real DOM
      //    events. Mirrors the URL <input> pattern below — bypasses React's
      //    value-tracker dedup so the controlled-input state actually advances.
      let toggleWasEnabled = false;
      if (wasDisabled) {
        const checkbox = modal.querySelector('label[data-qa-id="webhook"] input[data-qa-id="ui-lib-checkbox-input-input"]')
                      || modal.querySelector('[data-qa-id="webhook"] [data-qa-id="ui-lib-checkbox-input-input"]');
        if (!checkbox) { await cleanCancel(); return { error: 'webhook toggle checkbox not found', alert_id: ${alert_id} }; }
        const checkedSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked').set;
        checkedSetter.call(checkbox, true);
        checkbox.dispatchEvent(new Event('click', { bubbles: true }));
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        toggleWasEnabled = true;
        // Diagnostic reads on checkbox.checked: distinguish silent click
        // failure (checked stays false) from slow React re-render (checked
        // flips true but input.disabled lags).
        const checkboxCheckedAfterClick = !!checkbox.checked;
        await new Promise(r => setTimeout(r, 100));
        const checkboxCheckedAfter100ms = !!checkbox.checked;
        await new Promise(r => setTimeout(r, 200));
        const checkboxCheckedAfter300ms = !!checkbox.checked;
        // Give React one extra tick before polling input state.
        await new Promise(r => setTimeout(r, 50));
        // Poll 25ms × 20 = 500ms for input to become enabled.
        let enabled = false;
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 25));
          if (!urlInput.disabled) { enabled = true; break; }
        }
        if (!enabled) {
          await cleanCancel();
          return {
            error: 'toggle_enabled_but_input_still_disabled',
            alert_id: ${alert_id},
            checkbox_checked_after_click: checkboxCheckedAfterClick,
            checkbox_checked_after_100ms: checkboxCheckedAfter100ms,
            checkbox_checked_after_300ms: checkboxCheckedAfter300ms,
            input_disabled_after_500ms: !!urlInput.disabled,
            input_value_after_500ms: urlInput.value || '',
          };
        }
      }

      // 7. Set the URL value via native setter + dispatch input/change.
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(urlInput, newUrl);
      urlInput.dispatchEvent(new Event('input', { bubbles: true }));
      urlInput.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 100));
      if (urlInput.value !== newUrl) {
        await cleanCancel();
        return { error: 'url value did not stick', alert_id: ${alert_id}, observed_value: urlInput.value };
      }

      // 8. Click modal's Apply.
      const apply = modal.querySelector('[data-qa-id="submit"]');
      if (!apply) { await cleanCancel(); return { error: 'no submit (apply) in notifications modal', alert_id: ${alert_id} }; }
      const applyPK = Object.keys(apply).find(k => k.startsWith('__reactProps$'));
      if (!applyPK || !apply[applyPK].onClick) { await cleanCancel(); return { error: 'no onClick on apply', alert_id: ${alert_id} }; }
      apply[applyPK].onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, currentTarget: apply, target: apply, nativeEvent: {} });

      // 9. Wait for modal to close.
      let modalClosed = false;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 50));
        const stillModal = document.querySelector('[data-qa-id="alerts-notifications-edit-dialog"]');
        if (!stillModal || !stillModal.offsetWidth) { modalClosed = true; break; }
      }
      if (!modalClosed) {
        await cleanCancel();
        return { error: 'notifications modal did not close after apply', alert_id: ${alert_id} };
      }

      // 10. Click outer dialog's Save.
      await new Promise(r => setTimeout(r, 100));
      const dialogAfter = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
      if (!dialogAfter || !dialogAfter.offsetWidth) {
        return { error: 'outer dialog vanished after modal apply', alert_id: ${alert_id} };
      }
      const save = dialogAfter.querySelector('[data-qa-id="submit"]');
      if (!save) { await cleanCancel(); return { error: 'no save button in outer dialog', alert_id: ${alert_id} }; }
      const saveText = (save.textContent || '').trim();
      if (saveText !== 'Save') { await cleanCancel(); return { error: 'outer submit text is not Save', alert_id: ${alert_id}, save_text: saveText }; }
      const savePK = Object.keys(save).find(k => k.startsWith('__reactProps$'));
      if (!savePK || !save[savePK].onClick) { await cleanCancel(); return { error: 'no onClick on save', alert_id: ${alert_id} }; }
      save[savePK].onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, currentTarget: save, target: save, nativeEvent: {} });

      // 11. Wait for outer dialog to close. If it doesn't close within ~2s,
      //     report inconsistent-state failure (modal apply succeeded but
      //     persistence didn't finish). Caller's failure log + idempotent
      //     re-run handle this safely.
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 50));
        const still = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
        if (!still || !still.offsetWidth) {
          return {
            updated: true,
            alert_id: ${alert_id},
            old_url: oldUrl,
            new_url: newUrl,
            toggle_was_enabled: toggleWasEnabled,
          };
        }
      }
      return { error: 'outer_save_failed_after_modal_apply', alert_id: ${alert_id}, modal_applied: true };
    })()
  `;

  const res = await evaluateAsync(updateExpr);

  if (!res) {
    return { success: false, error: 'no result from update sequence', alert_id };
  }
  if (res.skipped) {
    return { success: true, action: 'skipped', alert_id, reason: res.reason, current_url: res.current_url, items_count: itemsCount };
  }
  if (res.updated) {
    return {
      success: true,
      action: 'updated',
      alert_id,
      old_url: res.old_url,
      new_url: res.new_url,
      toggle_was_enabled: res.toggle_was_enabled,
      items_count: itemsCount,
    };
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
  throw new Error('Individual alert deletion not yet supported. Use deleteAlert({ alert_id }) for per-alert delete, or delete_all: true for bulk-with-context-menu.');
}

/**
 * Delete a single alert subscription by alert_id.
 *
 * Pre-condition: TV Alerts panel must be open in the right widget bar.
 *
 * Idempotent: if alert_id is not in TV's REST list, returns
 * action="not_found" (already in target end state for delete).
 *
 * Verification: opens the dialog, reads the message-button content, compares
 * against the REST-fetched expected message body. Aborts if mismatched —
 * guards against the items[]-index-vs-callback-target drift surfaced during
 * 2026-05-08 probe (callbacks.onEditButtonClick(idx) sometimes opens a
 * different alert than items[idx] suggests, possibly due to dialog content
 * rendering lazily or items[] reordering). Mismatched dialog → cleanCancel
 * + return action="failed" with error="dialog_content_mismatch".
 *
 * Confirmation modal: TV may or may not show "Are you sure?" after delete
 * click. The IIFE polls for either (a) a confirm modal appearing, or (b)
 * the create-edit-dialog closing directly, whichever fires first within
 * 1.5s. If (a), clicks the modal's confirm button; if (b), treats as
 * direct-no-confirm. Returns confirmation_path field for observability.
 *
 * @param {Object} args
 * @param {number} args.alert_id - TV alert subscription id (from alert_list)
 * @returns {Promise<Object>} { success, action: "deleted"|"not_found"|"failed", alert_id, ... }
 */
export async function deleteAlert({ alert_id }) {
  if (typeof alert_id !== 'number' || !Number.isFinite(alert_id)) {
    return { success: false, error: 'alert_id must be a finite number', alert_id };
  }

  // Step A: REST pre-fetch — idempotency check + capture expected message for verification.
  const restRes = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include', cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        if (d.s !== 'ok' || !Array.isArray(d.r)) return { error: d.errmsg || 'unexpected response' };
        const a = d.r.find(x => x.alert_id === ${alert_id});
        return a ? { found: true, message: a.message || '', alert_id: a.alert_id } : { found: false };
      })
      .catch(e => ({ error: e.message }))
  `);
  if (!restRes || restRes.error) {
    return { success: false, error: 'REST pre-fetch failed: ' + (restRes?.error || 'no result'), alert_id };
  }
  if (!restRes.found) {
    return { success: true, action: 'not_found', alert_id, note: 'alert not in REST list — already deleted (idempotent success)' };
  }
  const expectedMessage = (restRes.message || '').trim();

  // Step B: stash items + callbacks (mirror updateMessage).
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

  // Step C: defensively clear search filter (same pattern as updateMessage).
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

  // Step D: per-alert delete IIFE.
  const expectedMessageEsc = JSON.stringify(expectedMessage);
  const deleteExpr = `
    (async function deleteOne() {
      const items = window.__efItems;
      const callbacks = window.__efCallbacks;
      if (!items || !callbacks) return { error: 'stash missing' };

      const idx = items.findIndex(it => it.id === ${alert_id});
      if (idx < 0) return { error: 'items_drift_alert_not_in_items', alert_id: ${alert_id}, items_total: items.length };

      // Force-close any stuck dialog from a prior iteration.
      async function cleanStuckDialog() {
        const stuckEditor = document.querySelector('[data-qa-id="alerts-message-edit-dialog"]');
        if (stuckEditor && stuckEditor.offsetWidth) {
          const c = stuckEditor.querySelector('[data-qa-id="cancel"]');
          if (c) {
            const pk = Object.keys(c).find(k => k.startsWith('__reactProps$'));
            if (pk && c[pk].onClick) c[pk].onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, currentTarget: c, target: c, nativeEvent: {} });
          }
          for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 50));
            const m = document.querySelector('[data-qa-id="alerts-message-edit-dialog"]');
            if (!m || !m.offsetWidth) break;
          }
        }
        const stuckDialog = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
        if (stuckDialog && stuckDialog.offsetWidth) {
          const c = stuckDialog.querySelector('[data-qa-id="cancel"]');
          if (c) {
            const pk = Object.keys(c).find(k => k.startsWith('__reactProps$'));
            if (pk && c[pk].onClick) c[pk].onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, currentTarget: c, target: c, nativeEvent: {} });
          }
          for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 50));
            const d = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
            if (!d || !d.offsetWidth) break;
          }
        }
      }
      await cleanStuckDialog();

      // Helper used in failure paths to leave UI clean.
      async function cleanCancel() {
        const dlg = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
        if (dlg && dlg.offsetWidth) {
          const c = dlg.querySelector('[data-qa-id="cancel"]');
          if (c) {
            const pk = Object.keys(c).find(k => k.startsWith('__reactProps$'));
            if (pk && c[pk].onClick) c[pk].onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, currentTarget: c, target: c, nativeEvent: {} });
          }
          for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 50));
            const d = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
            if (!d || !d.offsetWidth) break;
          }
        }
      }

      // 1. Open the dialog.
      callbacks.onEditButtonClick(idx);
      let dialog = null;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 50));
        dialog = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
        if (dialog && dialog.offsetWidth) break;
      }
      if (!dialog || !dialog.offsetWidth) return { error: 'dialog did not appear', alert_id: ${alert_id} };

      // 2. Wait for content to fully load — TV may use 2-stage render where
      //    the dialog template appears before alert data swaps in.
      await new Promise(r => setTimeout(r, 200));

      // 3. VERIFY dialog content matches the alert we expected. Read the
      //    message-button. Prefer textContent over data-overflow-tooltip-html
      //    for direct comparison without HTML-entity decoding.
      const msgBtn = dialog.querySelector('[data-qa-id="alert-message-button"]');
      if (!msgBtn) { await cleanCancel(); return { error: 'no alert-message-button in dialog', alert_id: ${alert_id} }; }
      const observedMessage = (msgBtn.textContent || '').trim();
      const expected = ${expectedMessageEsc};
      // Match: full-text equality OR observed is a prefix of expected (truncated display)
      // OR expected is a prefix of observed. Use first 60 chars to catch v22.3 LONG vs
      // SHORT distinction (direction field at ~position 80).
      const matchLen = Math.min(observedMessage.length, expected.length, 80);
      const matched = matchLen > 0 && (
        observedMessage === expected ||
        observedMessage.substring(0, matchLen) === expected.substring(0, matchLen)
      );
      if (!matched) {
        await cleanCancel();
        return {
          error: 'dialog_content_mismatch',
          alert_id: ${alert_id},
          expected_preview: expected.substring(0, 100),
          observed_preview: observedMessage.substring(0, 100),
          observed_len: observedMessage.length,
          expected_len: expected.length,
        };
      }

      // 4. Find the delete button.
      const deleteBtn = dialog.querySelector('[data-qa-id="delete"]');
      if (!deleteBtn) { await cleanCancel(); return { error: 'no [data-qa-id=delete] button in dialog', alert_id: ${alert_id} }; }
      const deletePK = Object.keys(deleteBtn).find(k => k.startsWith('__reactProps$'));
      if (!deletePK || !deleteBtn[deletePK].onClick) {
        await cleanCancel();
        return { error: 'no onClick on delete button', alert_id: ${alert_id} };
      }

      // 5. Click delete.
      deleteBtn[deletePK].onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, currentTarget: deleteBtn, target: deleteBtn, nativeEvent: {} });

      // 6. Poll for either (a) confirm modal appearing, or (b) dialog closing directly.
      //    Whichever fires within 1500ms determines next step.
      let confirmModal = null;
      let dialogClosedDirectly = false;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 50));
        // Check for confirm modal — try common qa-ids first, then heuristic dialog scan
        confirmModal = document.querySelector('[data-qa-id="confirm-dialog"]') ||
          document.querySelector('[data-name="alert-delete-confirm"]') ||
          (function() {
            const dialogs = document.querySelectorAll('[role="dialog"], [data-qa-id*="dialog"]');
            for (const d of dialogs) {
              if (d === dialog) continue;
              if (!d.offsetWidth) continue;
              const txt = (d.textContent || '').toLowerCase();
              if (/sure|confirm|delete this alert|remove this alert/i.test(txt) && /cancel|no|keep/i.test(txt)) return d;
            }
            return null;
          })();
        if (confirmModal) break;
        const stillMain = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
        if (!stillMain || !stillMain.offsetWidth) {
          dialogClosedDirectly = true;
          break;
        }
      }

      // 7a. Direct-delete path: dialog closed without confirmation.
      if (dialogClosedDirectly) {
        return {
          deleted: true,
          alert_id: ${alert_id},
          confirmation_path: 'direct_no_confirm',
          observed_preview: observedMessage.substring(0, 100),
        };
      }

      // 7b. Confirm-modal path: find confirm button + click it.
      if (confirmModal) {
        const confirmCandidates = [
          confirmModal.querySelector('[data-qa-id="confirm"]'),
          confirmModal.querySelector('[data-qa-id="yes"]'),
          confirmModal.querySelector('[data-qa-id="submit"]'),
          confirmModal.querySelector('[data-qa-id="delete"]'),
        ];
        let confirmBtn = null;
        for (const c of confirmCandidates) {
          if (c && c.offsetWidth) { confirmBtn = c; break; }
        }
        if (!confirmBtn) {
          // Fallback: scan visible buttons for confirm-y text
          for (const b of confirmModal.querySelectorAll('button')) {
            if (!b.offsetWidth) continue;
            const t = (b.textContent || '').trim().toLowerCase();
            if (/^(yes|confirm|delete|ok|remove)$/.test(t)) { confirmBtn = b; break; }
          }
        }
        if (!confirmBtn) {
          await cleanCancel();
          return {
            error: 'confirm_modal_appeared_but_no_confirm_button',
            alert_id: ${alert_id},
            modal_text_preview: (confirmModal.textContent || '').substring(0, 200),
          };
        }
        const confirmPK = Object.keys(confirmBtn).find(k => k.startsWith('__reactProps$'));
        if (!confirmPK || !confirmBtn[confirmPK].onClick) {
          await cleanCancel();
          return { error: 'no onClick on confirm button', alert_id: ${alert_id} };
        }
        confirmBtn[confirmPK].onClick({ preventDefault:()=>{}, stopPropagation:()=>{}, currentTarget: confirmBtn, target: confirmBtn, nativeEvent: {} });

        // Wait for create-edit-dialog to close (up to 6s — same as save poll for parity).
        for (let i = 0; i < 120; i++) {
          await new Promise(r => setTimeout(r, 50));
          const stillMain = document.querySelector('[data-qa-id="alerts-create-edit-dialog"]');
          if (!stillMain || !stillMain.offsetWidth) {
            return {
              deleted: true,
              alert_id: ${alert_id},
              confirmation_path: 'modal_confirmed',
              observed_preview: observedMessage.substring(0, 100),
            };
          }
        }
        return { error: 'main dialog did not close after confirm click', alert_id: ${alert_id}, confirmation_path: 'modal_confirmed_but_dialog_stuck' };
      }

      // 7c. Neither modal nor close — timeout.
      await cleanCancel();
      return { error: 'no confirm modal and dialog did not close within 1500ms', alert_id: ${alert_id} };
    })()
  `;

  const res = await evaluateAsync(deleteExpr);
  if (!res) {
    return { success: false, error: 'no result from delete sequence', alert_id };
  }
  if (res.deleted) {
    return {
      success: true,
      action: 'deleted',
      alert_id,
      confirmation_path: res.confirmation_path,
      observed_preview: res.observed_preview,
      items_count: itemsCount,
    };
  }
  return {
    success: false,
    action: 'failed',
    alert_id,
    error: res.error || 'unknown failure',
    detail: res,
    items_count: itemsCount,
  };
}
