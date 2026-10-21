// Run against an automation build, once in each UI language.
const lang = document.documentElement.lang;
const expected = lang === 'en'
  ? { name: 'Code Whereabouts', tagline: 'See where AI works and what it changes' }
  : { name: '코드행방', tagline: 'AI가 어디서 무엇을 바꾸는지' };
const title = `${expected.name} - ${expected.tagline}`;
const name = document.querySelector('.brand-name')?.textContent;
const tagline = document.querySelector('.brand-tagline')?.textContent;
if (name !== expected.name || tagline !== expected.tagline) throw 'Incorrect translated brand';
if (document.title !== title) throw 'Incorrect document title';
let windowTitle;
for (let i = 0; i < 100; i++) {
  windowTitle = await window.__TAURI_INTERNALS__.invoke('plugin:window|title', { label: 'main' });
  if (windowTitle === title) break;
  await new Promise((resolve) => setTimeout(resolve, 50));
}
if (windowTitle !== title) throw 'Incorrect native window title';
const brand = document.querySelector('.brand');
if (![brand, ...brand.querySelectorAll('span')].every((element) => element.hasAttribute('data-tauri-drag-region'))) throw 'Brand must remain draggable';
return { lang, name, tagline, documentTitle: document.title, windowTitle };
