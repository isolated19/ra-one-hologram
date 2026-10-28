/**
 * Collapsible conversation history: typed and spoken turns alike. Assistant entries carry
 * a "simulated" tag while no language model is connected; spoken user turns a "voice" tag.
 * The last entries survive restarts (localStorage, per device).
 */
const STORAGE_KEY = 'raone.history';
const KEEP = 100;

function load() {
  try {
    const items = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(items) ? items.slice(-KEEP) : [];
  } catch {
    return [];
  }
}

export class ConversationPanel {
  constructor(container, toggleButton) {
    this.el = container;
    this.toggleButton = toggleButton;
    this.list = document.createElement('ol');
    this.list.className = 'ra-history-list';
    this.el.appendChild(this.list);
    this.count = 0;
    this.open = false;
    this.items = [];
    toggleButton.addEventListener('click', () => this.setOpen(!this.open));
    for (const item of load()) this.add(item.role, item.text, { ...item, persist: false });
    this._label();
  }

  setOpen(open) {
    this.open = open;
    this.el.hidden = !open;
    this.toggleButton.setAttribute('aria-expanded', String(open));
    if (open) this.list.lastElementChild?.scrollIntoView({ block: 'end' });
    this._label();
  }

  _label() {
    this.toggleButton.textContent = `${this.open ? 'Hide' : 'History'} (${this.count})`;
  }

  /**
   * @param {'user'|'ra'} role
   * @param {string} text
   * @param {{ simulated?: boolean, via?: 'voice'|'text', ts?: number, persist?: boolean }} [opts]
   */
  add(role, text, { simulated = false, via = 'text', ts = Date.now(), persist = true } = {}) {
    if (!text) return;
    const li = document.createElement('li');
    li.className = `ra-msg ra-msg-${role}`;
    li.title = new Date(ts).toLocaleString();
    const who = document.createElement('span');
    who.className = 'ra-msg-who';
    who.textContent = role === 'user' ? 'YOU' : 'RA-ONE';
    const body = document.createElement('span');
    body.className = 'ra-msg-text';
    body.textContent = text;
    li.append(who, body);
    for (const [on, label] of [[simulated, 'SIMULATED'], [role === 'user' && via === 'voice', 'VOICE']]) {
      if (!on) continue;
      const tag = document.createElement('span');
      tag.className = 'ra-tag';
      tag.textContent = label;
      li.appendChild(tag);
    }
    this.list.appendChild(li);
    this.count++;
    this._label();
    if (this.open) li.scrollIntoView({ block: 'end' });

    this.items.push({ role, text, simulated, via, ts });
    if (this.items.length > KEEP) this.items.splice(0, this.items.length - KEEP);
    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.items)); } catch { /* ignore */ }
    }
  }
}
