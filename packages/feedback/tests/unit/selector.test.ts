import { beforeEach, describe, expect, it } from 'vitest';
import { buildSelector, isStableClass, isStableId, resolveSelector } from '../../src/selector';

function setup(html: string) {
  document.body.innerHTML = html;
}

function expectRoundTrip(el: Element) {
  const sel = buildSelector(el);
  const found = document.querySelectorAll(sel);
  expect(found.length, `selector "${sel}" must match exactly one element`).toBe(1);
  expect(found[0]).toBe(el);
  expect(resolveSelector(sel)).toBe(el);
  return sel;
}

describe('buildSelector', () => {
  beforeEach(() => setup(''));

  it('prefers data-testid', () => {
    setup('<div id="main"><button data-testid="save" id="btn" class="primary">Save</button></div>');
    expect(expectRoundTrip(document.querySelector('button')!)).toBe('[data-testid="save"]');
  });

  it('uses data-feedback-id', () => {
    setup('<section data-feedback-id="hero"><h1>Hi</h1></section>');
    expect(expectRoundTrip(document.querySelector('section')!)).toBe('[data-feedback-id="hero"]');
  });

  it('falls back to a unique id', () => {
    setup('<div><p id="intro">x</p></div>');
    expect(expectRoundTrip(document.querySelector('p')!)).toBe('#intro');
  });

  it('skips duplicate ids', () => {
    setup('<div class="a"><p id="dup">1</p></div><div class="b"><p id="dup">2</p></div>');
    const ps = document.querySelectorAll('p');
    const s1 = expectRoundTrip(ps[0]);
    const s2 = expectRoundTrip(ps[1]);
    expect(s1).not.toContain('#dup');
    expect(s2).not.toContain('#dup');
  });

  it('skips generated ids (React useId, numbers, uuid)', () => {
    setup('<div><span id=":r1:">a</span><span id="12345">b</span><span id="3f2a1b4c-1111-2222-3333-444455556666">c</span></div>');
    for (const el of Array.from(document.querySelectorAll('span'))) {
      expect(expectRoundTrip(el)).not.toContain('#');
    }
  });

  it('builds an nth-of-type path up to an anchored ancestor', () => {
    setup(`
      <nav id="menu"><ul>
        <li><a href="/a">A</a></li>
        <li><a href="/b">B</a></li>
        <li><a href="/c">C</a></li>
      </ul></nav>
      <ul><li><a href="/x">X</a></li></ul>`);
    const b = document.querySelectorAll('#menu a')[1];
    const sel = expectRoundTrip(b);
    expect(sel).toMatch(/nth-of-type\(2\)/);
  });

  it('does not use hashed classes when an alternative exists', () => {
    setup(`
      <div class="card"><button class="Button_primary__a1B2c css-1x2y3z sc-AxjAm">One</button></div>
      <div class="card"><button class="Button_primary__a1B2c css-1x2y3z sc-AxjAm">Two</button></div>`);
    const btns = document.querySelectorAll('button');
    for (const b of Array.from(btns)) {
      const sel = expectRoundTrip(b);
      expect(sel).not.toMatch(/__a1B2c|css-1x2y3z|sc-AxjAm/);
    }
  });

  it('does not use tailwind variant / arbitrary classes', () => {
    setup('<div><p class="hover:underline w-[13px] title">T</p><p class="title">U</p></div>');
    const sel = expectRoundTrip(document.querySelector('p')!);
    expect(sel).not.toMatch(/hover|13px/);
  });

  it('handles special characters in ids and attribute values', () => {
    setup('<div><b id="a.b:c">x</b><i data-testid=\'quote"d\'>y</i><u id="1st">z</u></div>');
    expectRoundTrip(document.querySelector('b')!);
    expectRoundTrip(document.querySelector('i')!);
    expectRoundTrip(document.querySelector('u')!);
  });

  it('round-trips for every element of a non-trivial document', () => {
    setup(`
      <header class="site-header"><a class="logo" href="/">Logo</a>
        <nav><a href="/1">1</a><a href="/2">2</a><a href="/2">2b</a></nav></header>
      <main>
        <article class="post"><h2>Title</h2><p>Text <em>em</em> <strong>s</strong></p><p>Second</p></article>
        <article class="post"><h2>Title</h2><p>Text</p><p>Second</p></article>
        <table><tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table>
        <form><label>Name <input name="n"></label><select><option>a</option></select><button>Go</button></form>
        <svg><circle r="3"></circle></svg>
      </main>
      <footer><p>© <span>2026</span></p></footer>`);
    for (const el of Array.from(document.body.querySelectorAll('*'))) expectRoundTrip(el);
  });

  it('returns html/body for the roots', () => {
    expect(buildSelector(document.documentElement)).toBe('html');
    expect(buildSelector(document.body)).toBe('body');
  });
});

describe('heuristics', () => {
  it.each(['card', 'btn-primary', 'site-header', 'col-md-6', 'is_ok_class'])('stable class %s', (c) => {
    expect(isStableClass(c)).toBe(true);
  });
  it.each(['css-1x2y3z', 'sc-AxjAm', 'Button_primary__a1B2c', '_3xQ9zA', 'jsx-123456', 'hover:bg-red', 'w-[13px]', 'w-1/2', 'active', 'is-open', 'x7Kp9q'])(
    'unstable class %s',
    (c) => {
      expect(isStableClass(c)).toBe(false);
    },
  );
  it.each(['main', 'user-menu', 'intro_text'])('stable id %s', (id) => expect(isStableId(id)).toBe(true));
  it.each([':r1:', '«r2»', 'ember123', '12345', 'radix-:r3:', 'a1b2c3d4'])('unstable id %s', (id) => expect(isStableId(id)).toBe(false));
});
