# DataPilot AI

**Navigate your data with AI.** A neomorphic web app for importing, cleaning and visualising
datasets — with an AI Agent that edits your data from natural-language prompts and a Power BI-style
dashboard studio.

## Features

- **Smart import** — drag & drop CSV / Excel files; every column is profiled automatically.
- **Agent Mode** — type instructions like *"remove all null rows and drop the id column"* and the
  LLM converts them into pandas operations.
- **Editor Mode** — clean data by hand: fill missing values, change types, rename/drop columns,
  sort, trim whitespace, edit individual cells.
- **Undo history** — revert the last change at any time.
- **Chart recommendations** — a heuristic engine ranks the most suitable charts for your dataset.
- **Dashboard Studio** — KPIs + pie, doughnut, bar, line, scatter and histogram charts; auto-build
  from recommendations or design your own.
- **Export** — download the cleaned dataset (CSV / Excel) and the whole dashboard (PNG / PDF).

## Tech stack

- **Frontend:** HTML, CSS (neomorphism theme), vanilla JS, Chart.js, Lucide icons, html2canvas, jsPDF.
- **Backend:** Python — Flask, pandas, numpy, openpyxl/xlsxwriter, OpenAI SDK.

## Project structure

```
DataPilot AI/
├── backend/
│   ├── app.py            # Flask server + API + static serving
│   ├── data_ops.py       # pandas engine (cleaning + chart aggregation + recommendations)
│   ├── llm_agent.py      # prompt -> operations (LLM)
│   ├── requirements.txt
│   └── .env.example
├── frontend/
│   ├── index.html        # landing page
│   ├── editor.html       # import + Agent/Editor modes
│   ├── dashboard.html    # dashboard studio
│   ├── css/style.css     # neomorphism theme
│   └── js/               # common.js, editor.js, dashboard.js
└── Images/DataPilot AI Logo.png
```

## Setup & run (Windows / PowerShell)

```powershell
cd "backend"
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

python app.py
```

Open **http://127.0.0.1:5000** in your browser.

## Agent Mode — free & unlimited with Ollama (default)

Agent Mode runs on a **free, unlimited, local** LLM via [Ollama](https://ollama.com) — no API key,
no cost, no rate limits, works offline. Setup (one time):

```powershell
# 1. Install Ollama from https://ollama.com/download
# 2. Download a model (a few GB):
ollama pull llama3.1
#    Lighter option for low-spec PCs:
#    ollama pull llama3.2
# 3. Ollama runs automatically at http://localhost:11434
```

Then start the app (`python app.py`) and use Agent Mode. The defaults
(`OPENAI_BASE_URL=http://localhost:11434/v1`, `OPENAI_MODEL=llama3.1`) are built in, so you don't
even need a `.env` file. **Editor Mode works with no setup at all.**

### Switching providers (optional)

You can point Agent Mode at any OpenAI-compatible endpoint by copying `.env.example` to `.env`
and editing it. Free cloud alternatives are documented there:

| Provider   | Free?             | Notes                                        |
|------------|-------------------|----------------------------------------------|
| **Ollama** | Yes, unlimited    | Local, no key, offline (default)             |
| **Groq**   | Yes (rate-limited)| Fast cloud, free key, no credit card         |
| **OpenRouter** | Yes (`:free` models) | Cloud, free key                       |

Environment overrides:

| Variable          | Default                        | Purpose                        |
|-------------------|--------------------------------|--------------------------------|
| `OPENAI_BASE_URL` | `http://localhost:11434/v1`    | LLM endpoint                   |
| `OPENAI_MODEL`    | `llama3.1`                     | Model name                     |
| `OPENAI_API_KEY`  | *(not needed for Ollama)*      | Only for cloud providers       |
| `PORT`            | `5000`                         | Server port                    |

## Example prompts (Agent Mode)

- "Remove all null rows and duplicate rows"
- "Drop the columns id and notes"
- "Fill missing values in age with the mean"
- "Rename column 'cust_name' to 'customer'"
- "Convert the date column to datetime and sort by it"
- "Keep only rows where country contains 'india'"
