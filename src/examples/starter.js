// Starter example. It deliberately shows the difference between children
// and childNodes: toggle "Hide whitespace" to see it.

export const STARTER = {
  html: `<main class="card">
  <h1>Hello, DOM 👋</h1>
  <p>Edit the code and press <kbd>Ctrl</kbd> + <kbd>Enter</kbd> (<kbd>⌘</kbd> + <kbd>Enter</kbd> on Mac).</p>

  <!-- JavaScript fills in the rest of this list -->
  <ul id="list">
    <li>HTML</li>
  </ul>
</main>
`,

  css: `body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  font-family: system-ui, sans-serif;
  background: #f5f5f7;
  color: #1d1d1f;
}

.card {
  padding: 32px 40px;
  border-radius: 20px;
  background: white;
  box-shadow: 0 10px 40px rgb(0 0 0 / 0.08);
}

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
};
