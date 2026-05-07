import { afterEach, describe, expect, it } from 'vitest';

import { asyncAlert, asyncConfirm, asyncPrompt } from '../js/modules/ui/components/async-modal.js';

function getRequiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  expect(element).not.toBeNull();
  return element as HTMLElement;
}

describe('async modal accessibility contract', () => {
  afterEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
  });

  it('labels and describes confirm dialogs', async () => {
    document.body.innerHTML = '<div id="app"></div><button id="opener">Open</button>';
    (document.getElementById('opener') as HTMLButtonElement).focus();

    const pending = asyncConfirm({ message: 'Delete this transaction?', details: 'This action cannot be undone.' });
    const modal = getRequiredElement('async-confirm-modal');

    expect(modal.getAttribute('aria-labelledby')).toBe('confirm-title');
    expect(modal.getAttribute('aria-describedby')).toBe('confirm-message confirm-details');

    getRequiredElement('confirm-cancel').click();
    await expect(pending).resolves.toBe(false);
  });

  it('restores focus to the invoking control after confirm dialogs close', async () => {
    document.body.innerHTML = '<div id="app"></div><button id="opener">Open</button>';
    const opener = document.getElementById('opener') as HTMLButtonElement;
    opener.focus();

    const pending = asyncConfirm({ message: 'Delete this transaction?' });
    getRequiredElement('confirm-cancel').click();
    await expect(pending).resolves.toBe(false);

    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(document.activeElement).toBe(opener);
  });

  it('labels and describes alert dialogs', async () => {
    const pending = asyncAlert({ message: 'Backup complete', type: 'success' });
    const modal = getRequiredElement('async-alert-modal');

    expect(modal.getAttribute('aria-labelledby')).toBe('alert-title');
    expect(modal.getAttribute('aria-describedby')).toBe('alert-message');

    getRequiredElement('alert-ok').click();
    await expect(pending).resolves.toBeUndefined();
  });

  it('keeps prompt dialogs wired to their visible message', async () => {
    const pending = asyncPrompt({ message: 'Name this template', defaultValue: 'Rent' });
    const modal = getRequiredElement('async-prompt-modal');

    expect(modal.getAttribute('aria-labelledby')).toBe('prompt-title');
    expect(modal.getAttribute('aria-describedby')).toBe('prompt-message');

    getRequiredElement('prompt-ok').click();
    await expect(pending).resolves.toBe('Rent');
  });

  it('restores focus to the invoking control after prompt dialogs close', async () => {
    document.body.innerHTML = '<div id="app"></div><button id="opener">Rename</button>';
    const opener = document.getElementById('opener') as HTMLButtonElement;
    opener.focus();

    const pending = asyncPrompt({ message: 'Name this template', defaultValue: 'Rent' });
    getRequiredElement('prompt-cancel').click();
    await expect(pending).resolves.toBeNull();

    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(document.activeElement).toBe(opener);
  });
});
