<h1>Project Description</h1>

SpoilerShield is an intelligent Chrome extension designed to protect users from unwanted spoilers while browsing the internet. In today’s fast-moving digital world, spoilers about movies, TV shows, anime, sports events, and web series spread rapidly across social media, news platforms, blogs, and forums. Even a single headline can ruin the entire experience for users.
SpoilerShield solves this problem using Artificial Intelligence.
The extension allows users to enter a specific topic (for example, a movie name or sports event), and it actively scans webpage content in real time. Using Google Gemini AI, the system analyzes the text contextually — not just by matching keywords, but by understanding whether the content reveals critical plot points or outcomes.
If spoiler content is detected, the extension automatically blurs or hides the section before the user reads it. This ensures a safe and spoiler-free browsing experience.

<h2>Core Objective</h2>

To build an AI-powered browser extension that:

Detects spoiler content contextually
Works in real-time
Allows user-controlled topic filtering
Prevents accidental exposure to spoilers

<h2>Innovation</h2>

Unlike traditional keyword blockers, SpoilerShield uses AI to understand meaning and context. This reduces false positives and increases accuracy in detecting actual spoilers instead of unrelated mentions.

<h2>Impact</h2>
<h1>Tech Stack – SpoilerShield </h1>
Frontend

HTML5 – Structure of popup interface

CSS3 – Styling and responsive UI design

JavaScript (ES6+) – Core logic and interaction handling

<h2>Browser Platform</h2>

Chrome Extension (Manifest V3)
Content Scripts (for scanning webpage text)
Background Service Worker
Chrome Storage API
Chrome Tabs API

<h2>AI Integration</h2>

Google Gemini API (Generative AI)
Contextual spoiler detection
Semantic content analysis
Keyword expansion & intelligent filtering

Data Handling

Chrome Local Storage
JSON-based API communication
Fetch API for network requests

Development & Testing

Google Chrome Developer Mode
Chrome Extensions Dashboard (chrome://extensions)
VS Code

Architecture Type

Client-side Extension Architecture
AI-assisted content moderation system

<h2>Key Features</h2>

AI-based semantic spoiler detection
<li>Custom topic input
<li>Real-time webpage scanning</li>
<li>Blur/hide spoiler content automatically</li>
<li>Toggle ON/OFF protection</li>
<li>Lightweight and easy-to-use interface</li>
<li>Enhances digital content consumption experience</li>
<li>Protects emotional investment in entertainment</li>
<li>Useful for movie lovers, sports fans, and binge-watchers</li>
<li>Scalable to social media platforms and mobile browsers</li>


<h1>Installation & Run  Commands</h1>
1. Clone the Repository
git clone https://github.com/your-username/SpoilerShield.git
cd SpoilerShield
Or download the ZIP file and extract it. 
2. Load the Extension in Chrome
Since SpoilerShield is a Chrome Extension (Manifest V3), no npm install or server setup is required.
Step 1: Open Chrome Extensions Page
Open your browser and navigate to:
chrome://extensions/
Step 2: Enable Developer Mode
Toggle Developer Mode ON (top-right corner).
Step 3: Load the Project
Click Load Unpacked
Select the SpoilerShield project folder.
The extension will now be installed and visible in the Chrome toolbar.
3. Run the Extension
Click the SpoilerShield icon.
Enter a topic (e.g., a movie or sports event).
Enable protection.
Browse normally — spoiler content will be detected and hidden automatically.
Updating After Code Changes
Whenever you modify the code:
Go to chrome://extensions/
Click the Reload button on the SpoilerShield extension.

</h1>Team Members</h1>

1.Gouri Lakshmi MS
2.Anila Roy

<h1>License info</h1>
MIT License

Copyright (c) 2026 Gouri Lakshmi M S

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
