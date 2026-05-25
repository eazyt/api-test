// app.js
const express = require('express');
const app = express();
const port = 3000;

// Sample lorem ipsum words for names
const loremNames = ['Lorem', 'Ipsum', 'Dolor', 'Sit', 'Amet', 'Consectetur', 'Adipiscing', 'Elit'];

// Sample bios
const bios = [
  'A creative thinker with a passion for design.',
  'An experienced developer who loves solving problems.',
  'A storyteller with a knack for engaging audiences.',
  'A strategist focused on building scalable solutions.',
  'An innovator constantly exploring new ideas.'
];

// Helper: wrap content in Bootstrap layout
function pageTemplate(title, content, refreshPath = null) {
  const buttons = refreshPath
    ? `
      <div class="mt-3">
        <a href="/" class="btn btn-primary me-2">Home</a>
        <a href="${refreshPath}" class="btn btn-secondary">Refresh</a>
      </div>
    `
    : '';

  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>${title}</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  </head>
  <body class="d-flex flex-column min-vh-100">
    <!-- Header -->
    <nav class="navbar navbar-expand-lg navbar-dark bg-dark">
      <div class="container-fluid">
        <a class="navbar-brand" href="/">Random API</a>
        <div class="collapse navbar-collapse">
          <ul class="navbar-nav me-auto">
            <li class="nav-item"><a class="nav-link" href="/random">Numbers</a></li>
            <li class="nav-item"><a class="nav-link" href="/names">Names</a></li>
            <li class="nav-item"><a class="nav-link" href="/details">Details</a></li>
          </ul>
        </div>
      </div>
    </nav>

    <!-- Main content -->
    <main class="flex-grow-1 d-flex justify-content-center align-items-center text-center">
      <div>
        ${content}
        ${buttons}
      </div>
    </main>

    <!-- Footer -->
    <footer class="bg-dark text-light text-center py-2 mt-auto">
      eat, sleep, automate — by eazyt
    </footer>
  </body>
  </html>
  `;
}

// Homepage
app.get('/', (req, res) => {
  res.send(pageTemplate('Home', `
    <h1>Welcome to the Random API</h1>
    <p>Select an option from the header above.</p>
  `));
});

// Random number
app.get('/random', (req, res) => {
  const randomNumber = Math.floor(Math.random() * 1000);
  res.send(pageTemplate('Random Number', `<h2>Random Number: ${randomNumber}</h2>`, '/random'));
});

// Random name
app.get('/names', (req, res) => {
  const randomName = loremNames[Math.floor(Math.random() * loremNames.length)];
  res.send(pageTemplate('Random Name', `<h2>Random Name: ${randomName}</h2>`, '/names'));
});

// Random full name + bio
app.get('/details', (req, res) => {
  const firstName = loremNames[Math.floor(Math.random() * loremNames.length)];
  const lastName = loremNames[Math.floor(Math.random() * loremNames.length)];
  const bio = bios[Math.floor(Math.random() * bios.length)];
  res.send(pageTemplate('Details', `
    <h2>${firstName} ${lastName}</h2>
    <p>${bio}</p>
  `, '/details'));
});

// Start server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

