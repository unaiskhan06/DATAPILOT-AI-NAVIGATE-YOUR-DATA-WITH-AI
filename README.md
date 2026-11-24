# DataPilot AI

**Navigate your data with AI.**

DataPilot AI is a browser-based data analysis workspace built with Flask, pandas,
vanilla JavaScript, and Chart.js. Import CSV or Excel files, clean and transform
datasets, use natural-language prompts for AI-assisted edits, and build
presentation-ready dashboards.

<p align="center">
  <img src="./Images/DataPilot%20AI_%20Navigate%20Your%20Data%20for%20laptop.png"
       alt="DataPilot AI dashboard wallpaper"
       width="80%">
</p>

## Demo

[![Watch the DataPilot AI demo](./Images/DataPilot%20AI%20Futuristic%20Tech%20Wallpaper%20for%20computer.png)](./Images/DataPilot%20AI%20Demo.mp4)

[Download or play the demo video](./Images/DataPilot%20AI%20Demo.mp4)

## Screenshots

<p align="center">
  <img src="./Images/DataPilot%20AI%20Futuristic%20Tech%20Wallpaper%20for%20computer.png"
       alt="DataPilot AI futuristic technology wallpaper"
       width="49%">
  <img src="./Images/DataPilot%20AI%20Futuristic%20Wave%20Wallpaper%20for%20mobile.png"
       alt="DataPilot AI futuristic wave wallpaper"
       width="49%">
</p>

## Features

- CSV and Excel dataset import
- Multiple worksheet support for Excel workbooks
- Automatic column profiling and chart recommendations
- 3D model visualization and presentation
- Manual Editor Mode with:
  - Missing-value handling
  - Column type conversion
  - Rename, drop, and sort operations
  - Whitespace trimming
  - Duplicate removal
  - Individual cell editing
  - Undo and history rollback
- AI Agent Mode for natural-language data operations
- KPI cards and charts including bar, line, pie, doughnut, scatter,
  histogram, and pivot views
- Interactive dashboard layout with movable charts and saved positioning
- Dashboard backgrounds and PNG export
- PDF, PPTX, CSV, and Excel report/export options
- Signup, email verification, Google OAuth, and profile management
- Relationship analysis and merge workflows
- Geographic column detection and geo-visualization support

## Technology

| Area | Technology |
|---|---|
| Backend | Python, Flask |
| Data processing | pandas, NumPy, openpyxl, XlsxWriter |
| Frontend | HTML, CSS, vanilla JavaScript |
| Charts and exports | Chart.js, html2canvas, jsPDF, python-pptx |
| AI | OpenAI-compatible APIs, including Ollama |
| Authentication | Flask sessions, SQLite, Google OAuth |

There is no Node.js build step.

## Project Structure

```text
DataPilot AI/
├── backend/
│   ├── app.py              # Flask application and API routes
│   ├── auth.py             # Account and authentication handling
│   ├── data_ops.py         # pandas operations and profiling
│   ├── llm_agent.py        # OpenAI/Ollama agent integration
│   ├── report.py           # report generation helpers
│   ├── requirements.txt    # local development dependencies
│   └── .env.example        # configuration template
├── frontend/
│   ├── index.html
│   ├── login.html
│   ├── signup.html
│   ├── profile.html
│   ├── editor.html
│   ├── dashboard.html
│   ├── css/
│   └── js/
├── Images/
├── requirements.txt        # production dependencies
├── render.yaml             # Render deployment blueprint
└── _check_dashboard.py     # dashboard browser regression check
```

## Local Setup

Run all setup commands from the repository root in PowerShell.

### 1. Create or use the virtual environment

The repository uses `.venv` at the repository root.

```powershell
python -m venv .venv
& ".venv/Scripts/python.exe" -m pip install -U pip
& ".venv/Scripts/python.exe" -m pip install -r backend/requirements.txt
```

If `.venv` already exists, installation can be run directly:

```powershell
& ".venv/Scripts/python.exe" -m pip install -r backend/requirements.txt
```

### 2. Configure environment variables

Copy the example configuration:

```powershell
Copy-Item "backend/.env.example" "backend/.env"
```

The application can run without external AI or OAuth configuration. Editor and
dashboard access require a signed-in account.

Generate a secure session secret:

```powershell
& ".venv/Scripts/python.exe" -c "import secrets; print(secrets.token_hex(32))"
```

Place the generated value in `backend/.env`:

```dotenv
APP_SECRET_KEY=replace-with-the-generated-secret
```

Do not commit `backend/.env`, API keys, OAuth secrets, or app passwords.

### 3. Start the application

```powershell
& ".venv/Scripts/python.exe" "backend/app.py"
```

Open **http://127.0.0.1:5000**.

To keep the server running after starting it from PowerShell:

```powershell
Start-Process -FilePath ".venv\Scripts\python.exe" `
  -ArgumentList "backend/app.py" `
  -WorkingDirectory "E:\UNAIS KHAN\PROGRAMS\DataPilot AI" `
  -WindowStyle Hidden
```

## AI Agent Mode

Agent Mode uses an OpenAI-compatible API. Ollama is the default local provider.

### Ollama setup

1. Install Ollama: https://ollama.com/download
2. Download a model:

```powershell
ollama pull llama3.1
```

A smaller option is available with:

```powershell
ollama pull llama3.2
```

The default configuration is:

```dotenv
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_MODEL=llama3.1
```

No `OPENAI_API_KEY` is required for Ollama.

### Groq or OpenRouter

Use one provider block at a time in `backend/.env`:

```dotenv
# Groq
OPENAI_BASE_URL=https://api.groq.com/openai/v1
OPENAI_MODEL=llama-3.3-70b-versatile
OPENAI_API_KEY=your-groq-api-key
```

```dotenv
# OpenRouter
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_MODEL=meta-llama/llama-3.3-70b-instruct:free
OPENAI_API_KEY=your-openrouter-api-key
```

Example prompts:

- Remove all null rows and duplicate rows
- Drop the columns `id` and `notes`
- Fill missing values in `age` with the mean
- Rename `cust_name` to `customer`
- Convert `date` to datetime and sort by it
- Keep only rows where `country` contains `India`

## Authentication

Account data is stored in `backend/users.db`.

### Email verification

If SMTP variables are not configured, verification links are returned for local
development and printed to the server console. For email delivery, configure
Gmail SMTP with an app password:

```dotenv
APP_BASE_URL=http://127.0.0.1:5000
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your.email@gmail.com
SMTP_PASSWORD=your-gmail-app-password
SMTP_FROM=your.email@gmail.com
```

Use an app password rather than the account password.

### Google OAuth

Create a web OAuth client in Google Cloud Console and add:

```text
http://127.0.0.1:5000/api/auth/google/callback
```

to the authorized redirect URIs, then configure:

```dotenv
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REDIRECT_URI=http://127.0.0.1:5000/api/auth/google/callback
```

For LAN or phone access, set the redirect URI to the actual host URL and add it
to Google OAuth, for example:

```text
http://192.168.1.7:5000/api/auth/google/callback
```

## LAN Access

Set the host to all network interfaces:

```dotenv
HOST=0.0.0.0
PORT=5000
```

Allow the port through Windows Firewall:

```powershell
netsh advfirewall firewall add rule name="DataPilot AI 5000" `
  dir=in action=allow protocol=TCP localport=5000
```

Open the application from another device using the PC's LAN IP:

```text
http://<pc-lan-ip>:5000
```

## Browser Regression Check

With the application running, execute:

```powershell
& ".venv/Scripts/python.exe" "_check_dashboard.py"
```

This check uses Playwright, installed Edge, and Pillow. It intercepts API calls
with synthetic data and writes `_dashboard_check.png` in the repository root.

## Deployment

The repository includes `render.yaml` for a Render Blueprint deployment.

1. Push the repository to GitHub.
2. In Render, choose **New + > Blueprint** and select the repository.
3. Set `APP_SECRET_KEY`, `OPENAI_API_KEY`, `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` in the Render dashboard.
4. Use the public Render URL for the Google OAuth redirect:

```text
https://<service-name>.onrender.com/api/auth/google/callback
```

The production server runs with:

```text
gunicorn app:app --chdir backend --bind 0.0.0.0:$PORT --workers 1 --threads 8 --timeout 120
```

Keep the worker count at `1`. Uploaded datasets are held in process memory, and
multiple workers would split session state across processes. A persistent
database or shared storage is required before increasing the worker count.

Render's filesystem is ephemeral on free and starter plans. `backend/users.db`
and uploaded datasets are not guaranteed to survive a deploy or restart.
