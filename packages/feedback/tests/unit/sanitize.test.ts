import { describe, expect, it } from 'vitest';
import { describeTarget, getSafeAttributes, getTextSnippet, isPrivateElement } from '../../src/selector/sanitize';

const SECRET = 'SECRET-4242';

describe('privacy', () => {
  it('never puts form values into snippet or attributes', () => {
    document.body.innerHTML = `
      <form id="f" class="login">
        <label>Email <input id="email" name="email" value="${SECRET}"></label>
        <textarea name="bio">${SECRET}</textarea>
        <select name="s"><option selected>${SECRET}</option></select>
        <div contenteditable="true">${SECRET}</div>
        <div data-feedback-ignore>${SECRET}</div>
        <button>Sign in</button>
      </form>`;
    const input = document.querySelector('input')!;
    input.value = SECRET;
    document.querySelector('textarea')!.value = SECRET;

    const form = document.getElementById('f')!;
    const target = describeTarget(form);
    expect(JSON.stringify(target)).not.toContain(SECRET);
    expect(target.textSnippet).toContain('Email');
    expect(target.textSnippet).toContain('Sign in');

    for (const el of Array.from(form.querySelectorAll('*'))) {
      expect(JSON.stringify(describeTarget(el)), el.outerHTML).not.toContain(SECRET);
    }
  });

  it('drops value-like attributes and keeps identifying ones', () => {
    document.body.innerHTML = `<input id="q" class="search" name="q" type="search" value="${SECRET}" data-value="${SECRET}" data-testid="search" aria-label="Search" placeholder="Find">`;
    const attrs = getSafeAttributes(document.querySelector('input')!);
    expect(attrs).toEqual({ id: 'q', class: 'search', name: 'q', type: 'search', 'data-testid': 'search' });
  });

  it('keeps allowed attributes for normal elements', () => {
    document.body.innerHTML = `<a id="l" class="x y" href="/p?a=1" role="button" aria-label="Open" data-track="nav" onclick="x()" style="color:red">Go</a>`;
    expect(getSafeAttributes(document.querySelector('a')!)).toEqual({
      id: 'l',
      class: 'x y',
      href: '/p?a=1',
      role: 'button',
      'aria-label': 'Open',
      'data-track': 'nav',
    });
  });

  it('marks private elements', () => {
    document.body.innerHTML = `<input><textarea></textarea><select></select><div contenteditable><p>x</p></div><div data-feedback-ignore><span>y</span></div><p>z</p>`;
    expect(isPrivateElement(document.querySelector('input')!)).toBe(true);
    expect(isPrivateElement(document.querySelector('textarea')!)).toBe(true);
    expect(isPrivateElement(document.querySelector('select')!)).toBe(true);
    expect(isPrivateElement(document.querySelector('[contenteditable] p')!)).toBe(true);
    expect(isPrivateElement(document.querySelector('[data-feedback-ignore] span')!)).toBe(true);
    expect(isPrivateElement(document.querySelector('body > p')!)).toBe(false);
  });

  it('respects a custom ignore selector', () => {
    document.body.innerHTML = `<div id="w"><span class="pii">${SECRET}</span> visible</div>`;
    const el = document.getElementById('w')!;
    expect(getTextSnippet(el, '.pii')).toBe('visible');
  });
});

describe('textSnippet', () => {
  it('collapses whitespace and truncates to 120 chars', () => {
    document.body.innerHTML = `<p>  ${'word '.repeat(60)}  </p>`;
    const s = getTextSnippet(document.querySelector('p')!);
    expect(s.length).toBeLessThanOrEqual(120);
    expect(s.endsWith('…')).toBe(true);
    expect(s).not.toMatch(/\s{2}/);
  });

  it('skips scripts, styles and hidden elements', () => {
    document.body.innerHTML = `<div>A<script>var x=1</script><style>p{}</style><span hidden>B</span><span style="display:none">C</span>D</div>`;
    expect(getTextSnippet(document.querySelector('div')!)).toBe('A D');
  });
});
