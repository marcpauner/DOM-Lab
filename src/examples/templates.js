/*
 * Example projects. Each one focuses on one part of the DOM and suggests
 * what to look at in DOM Lab (the tree, the Changes tab, the details panel…).
 */

// A shared look, so every example starts from a clean page
const BASE_CSS = `body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  font-family: system-ui, sans-serif;
  background: #f5f5f7;
  color: #1d1d1f;
}

.card {
  min-width: 280px;
  padding: 28px 36px;
  border-radius: 20px;
  background: white;
  box-shadow: 0 10px 40px rgb(0 0 0 / 0.08);
}

button {
  font: inherit;
  padding: 6px 14px;
  border: 0;
  border-radius: 999px;
  background: #0071e3;
  color: white;
  cursor: pointer;
}
`;

/** @type {Array<{ id: string, title: string, description: string, html: string, css: string, js: string }>} */
export const TEMPLATES = [
  {
    id: 'hello',
    title: 'Hello, DOM',
    description: 'children vs childNodes: toggle "Hide whitespace" in the tree.',
    html: `<main class="card">
  <h1>Hello, DOM 👋</h1>
  <p>Edit the code and press <kbd>Ctrl</kbd> + <kbd>Enter</kbd> (<kbd>⌘</kbd> + <kbd>Enter</kbd> on Mac).</p>

  <!-- JavaScript fills in the rest of this list -->
  <ul id="list">
    <li>HTML</li>
  </ul>
</main>
`,
    css: `${BASE_CSS}
li.new {
  color: #0071e3;
}
`,
    js: `const list = document.querySelector('#list');

for (const name of ['CSS', 'JavaScript']) {
  const li = document.createElement('li');
  li.textContent = name;
  li.className = 'new';
  list.append(li);
}

// children only counts elements; childNodes also counts text nodes
console.log('children:', list.children.length);
console.log('childNodes:', list.childNodes.length);
console.log(list);
`,
  },

  {
    id: 'events',
    title: 'Events and delegation',
    description: 'A to-do list: one listener on the <ul> handles every button. See the Events tab.',
    html: `<main class="card">
  <h1>To-do</h1>
  <form id="new-task">
    <input name="task" placeholder="New task" autocomplete="off" required>
    <button>Add</button>
  </form>

  <!-- One listener on the <ul> handles the × buttons of every task -->
  <ul id="tasks">
    <li>Learn the DOM <button class="remove" aria-label="Remove">×</button></li>
  </ul>
</main>
`,
    css: `${BASE_CSS}
form {
  display: flex;
  gap: 8px;
}

input {
  flex: 1;
  font: inherit;
  padding: 6px 12px;
  border: 1px solid #d2d2d7;
  border-radius: 999px;
}

ul {
  padding: 0;
  list-style: none;
}

li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid #f0f0f2;
}

.remove {
  padding: 0 10px;
  background: #ff3b30;
}
`,
    js: `const form = document.querySelector('#new-task');
const tasks = document.querySelector('#tasks');

form.addEventListener('submit', (event) => {
  event.preventDefault(); // stay on the page instead of sending the form

  const li = document.createElement('li');
  li.append(form.elements.task.value + ' ');

  const remove = document.createElement('button');
  remove.className = 'remove';
  remove.textContent = '×';
  li.append(remove);

  tasks.append(li);
  form.reset();
});

// Event delegation: a click on any × bubbles up to the <ul>.
// It works for buttons that did not exist yet when this line ran.
tasks.addEventListener('click', (event) => {
  const button = event.target.closest('.remove');
  if (button) button.closest('li').remove();
});
`,
  },

  {
    id: 'create',
    title: 'Creating elements',
    description: 'createElement, <template> + cloneNode and DocumentFragment.',
    html: `<main class="card">
  <h1>Planets</h1>
  <section id="cards"></section>
</main>

<!-- A <template> is not rendered: its content lives in template.content -->
<template id="planet">
  <article class="planet">
    <h2></h2>
    <p></p>
  </article>
</template>
`,
    css: `${BASE_CSS}
#cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.planet {
  padding: 12px 16px;
  border-radius: 14px;
  background: #f5f5f7;
}

.planet h2 {
  margin: 0 0 4px;
  font-size: 1.1rem;
}

.planet p {
  margin: 0;
  color: #6e6e73;
}
`,
    js: `const planets = [
  { name: 'Mercury', moons: 0 },
  { name: 'Earth', moons: 1 },
  { name: 'Mars', moons: 2 },
];

const template = document.querySelector('#planet');
// A DocumentFragment collects the new nodes off-screen…
const fragment = document.createDocumentFragment();

for (const planet of planets) {
  // cloneNode(true) copies the template's content with all its children
  const card = template.content.cloneNode(true);
  card.querySelector('h2').textContent = planet.name;
  card.querySelector('p').textContent = planet.moons + ' moon(s)';
  fragment.append(card);
}

// …and they are added to the page in one single operation
document.querySelector('#cards').append(fragment);
console.log('Fragment after append (it is empty now):', fragment.childNodes.length);
`,
  },

  {
    id: 'classes',
    title: 'Classes, styles and dataset',
    description: 'classList, element.style and data-* attributes. Watch the Changes tab.',
    html: `<main class="card" id="box" data-clicks="0">
  <h1>Click the buttons</h1>
  <p>
    <button id="toggle">Toggle .dark</button>
    <button id="bigger">Bigger text</button>
  </p>
  <p id="info"></p>
</main>
`,
    css: `${BASE_CSS}
.card {
  transition: background 0.3s, color 0.3s;
}

.card.dark {
  background: #1d1d1f;
  color: #f5f5f7;
}
`,
    js: `const box = document.querySelector('#box');
const info = document.querySelector('#info');

function update() {
  // dataset reads the data-* attributes: data-clicks → dataset.clicks (always a string)
  box.dataset.clicks = Number(box.dataset.clicks) + 1;
  info.textContent = 'class="' + box.className + '" · data-clicks="' + box.dataset.clicks + '"';
}

document.querySelector('#toggle').addEventListener('click', () => {
  box.classList.toggle('dark'); // adds the class if missing, removes it if present
  update();
});

document.querySelector('#bigger').addEventListener('click', () => {
  // element.style writes the inline style="…" attribute
  const size = parseFloat(getComputedStyle(box).fontSize);
  box.style.fontSize = size + 2 + 'px';
  update();
});

update();
`,
  },

  {
    id: 'timers',
    title: 'Timers and live changes',
    description: 'setInterval updates the DOM: watch the tree flash and the Changes tab group them.',
    html: `<main class="card">
  <h1 id="clock">--:--:--</h1>
  <div class="bar"><div id="progress"></div></div>
  <p id="status">Counting…</p>
</main>
`,
    css: `${BASE_CSS}
#clock {
  font-variant-numeric: tabular-nums;
}

.bar {
  height: 8px;
  border-radius: 99px;
  background: #e8e8ed;
  overflow: hidden;
}

#progress {
  width: 0;
  height: 100%;
  background: #34c759;
  transition: width 0.3s;
}
`,
    js: `const clock = document.querySelector('#clock');
const progress = document.querySelector('#progress');
const status = document.querySelector('#status');
let seconds = 0;

const timer = setInterval(() => {
  seconds++;
  // textContent replaces the text node inside the <h1>
  clock.textContent = new Date().toLocaleTimeString();
  progress.style.width = seconds * 10 + '%';

  if (seconds === 10) {
    clearInterval(timer);
    status.textContent = 'Done!';
  }
}, 1000);
`,
  },

  {
    id: 'traverse',
    title: 'Walking the tree',
    description: 'parentNode, children, siblings, closest and querySelectorAll, logged to the console.',
    html: `<main class="card">
  <h1>Menu</h1>
  <ul id="menu">
    <li>Home</li>
    <li class="active">Courses
      <ul>
        <li>HTML</li>
        <li id="dom">DOM</li>
      </ul>
    </li>
    <li>Contact</li>
  </ul>
</main>
`,
    css: `${BASE_CSS}
.active {
  font-weight: 600;
}

.found {
  color: #0071e3;
}
`,
    js: `const dom = document.querySelector('#dom');

// Going up
console.log('parentNode:', dom.parentNode);
console.log('closest(".active"):', dom.closest('.active'));

// Going sideways (Element versions skip the whitespace text nodes)
console.log('previousSibling:', dom.previousSibling);
console.log('previousElementSibling:', dom.previousElementSibling);

// Going down
const menu = document.querySelector('#menu');
console.log('children:', menu.children);
console.log('firstChild:', menu.firstChild);
console.log('firstElementChild:', menu.firstElementChild);

// Searching: querySelectorAll returns a static NodeList
const items = document.querySelectorAll('#menu li');
console.log(items.length + ' <li> elements in total');
items.forEach((item) => item.classList.add('found'));
`,
  },

  {
    id: 'blank',
    title: 'Blank page',
    description: 'Start from scratch.',
    html: '',
    css: '',
    js: '',
  },
];
