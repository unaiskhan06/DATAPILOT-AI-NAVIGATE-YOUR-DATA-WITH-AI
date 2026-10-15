"""
data_ops.py
Core data-processing engine for DataPilot AI.
Wraps pandas operations used by both the manual Editor mode and the AI Agent mode.
Every mutating operation returns a NEW DataFrame so callers can manage undo history.
"""
from __future__ import annotations

import io
import numpy as np
import pandas as pd


# --------------------------------------------------------------------------- #
#  Loading / saving
# --------------------------------------------------------------------------- #
def load_dataframe(file_storage) -> pd.DataFrame:
    """Read an uploaded file (csv / xls / xlsx) into a DataFrame."""
    filename = (file_storage.filename or "").lower()
    data = file_storage.read()
    buffer = io.BytesIO(data)

    if filename.endswith(".csv"):
        # Try a couple of common encodings.
        try:
            return pd.read_csv(io.BytesIO(data))
        except UnicodeDecodeError:
            return pd.read_csv(io.BytesIO(data), encoding="latin-1")
    if filename.endswith((".xlsx", ".xls")):
        return pd.read_excel(buffer)
    # Fallback: attempt CSV.
    return pd.read_csv(io.BytesIO(data))


def dataframe_to_csv_bytes(df: pd.DataFrame) -> bytes:
    return df.to_csv(index=False).encode("utf-8")


def dataframe_to_excel_bytes(df: pd.DataFrame) -> bytes:
    buffer = io.BytesIO()
    with pd.ExcelWriter(buffer, engine="xlsxwriter") as writer:
        df.to_excel(writer, index=False, sheet_name="Data")
    buffer.seek(0)
    return buffer.read()


# --------------------------------------------------------------------------- #
#  Serialization helpers (JSON-safe)
# --------------------------------------------------------------------------- #
def _json_safe(value):
    if value is None:
        return None
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return None if np.isnan(value) else float(value)
    if isinstance(value, (np.bool_,)):
        return bool(value)
    if isinstance(value, float) and np.isnan(value):
        return None
    if pd.isna(value):
        return None
    return value


def preview(df: pd.DataFrame, limit: int | None = None) -> dict:
    """Return a JSON-serialisable preview + metadata of the DataFrame.

    When ``limit`` is None (the default) the full DataFrame is returned so the
    UI can display every row and every column.
    """
    head = df if limit is None else df.head(limit)
    columns = list(df.columns)
    # Vectorised row extraction (much faster than scalar .iloc for large frames).
    rows = [
        {columns[j]: _json_safe(record[j]) for j in range(len(columns))}
        for record in head.itertuples(index=False, name=None)
    ]
    return {
        "columns": list(df.columns.astype(str)),
        "rows": rows,
        "total_rows": int(df.shape[0]),
        "total_cols": int(df.shape[1]),
        "shown_rows": len(rows),
    }


def profile(df: pd.DataFrame) -> dict:
    """Compute a summary profile used for stats + dashboard recommendations."""
    columns = []
    for col in df.columns:
        series = df[col]
        dtype = str(series.dtype)
        if pd.api.types.is_numeric_dtype(series):
            kind = "numeric"
        elif pd.api.types.is_datetime64_any_dtype(series):
            kind = "datetime"
        else:
            kind = "categorical"
        nunique = int(series.nunique(dropna=True))
        missing = int(series.isna().sum())
        info = {
            "name": str(col),
            "dtype": dtype,
            "kind": kind,
            "unique": nunique,
            "missing": missing,
            "missing_pct": round(missing / max(len(df), 1) * 100, 2),
        }
        if kind == "numeric" and len(series.dropna()):
            info.update(
                {
                    "min": _json_safe(series.min()),
                    "max": _json_safe(series.max()),
                    "mean": _json_safe(round(float(series.mean()), 4)),
                    "std": _json_safe(round(float(series.std()), 4))
                    if len(series.dropna()) > 1
                    else 0,
                }
            )
        columns.append(info)

    return {
        "total_rows": int(df.shape[0]),
        "total_cols": int(df.shape[1]),
        "total_missing": int(df.isna().sum().sum()),
        "duplicate_rows": int(df.duplicated().sum()),
        "memory_kb": round(df.memory_usage(deep=True).sum() / 1024, 2),
        "columns": columns,
    }


# --------------------------------------------------------------------------- #
#  Cleaning / transform operations
#  Each returns (new_df, human_message)
# --------------------------------------------------------------------------- #
def op_remove_null_rows(df, columns=None, **_):
    before = len(df)
    new = df.dropna(subset=columns) if columns else df.dropna()
    return new, f"Removed {before - len(new)} rows containing null values."


def op_remove_null_columns(df, threshold=None, **_):
    before = df.shape[1]
    if threshold is not None:
        # drop columns whose missing fraction exceeds threshold (0-1)
        keep = [c for c in df.columns if df[c].isna().mean() <= float(threshold)]
        new = df[keep]
    else:
        new = df.dropna(axis=1, how="any")
    return new, f"Removed {before - new.shape[1]} column(s) with null values."


def op_remove_duplicates(df, columns=None, **_):
    before = len(df)
    new = df.drop_duplicates(subset=columns) if columns else df.drop_duplicates()
    return new, f"Removed {before - len(new)} duplicate row(s)."


def op_fill_missing(df, columns=None, method="value", value=0, **_):
    new = df.copy()
    targets = columns or list(df.columns)
    for col in targets:
        if col not in new.columns:
            continue
        if method == "mean" and pd.api.types.is_numeric_dtype(new[col]):
            new[col] = new[col].fillna(new[col].mean())
        elif method == "median" and pd.api.types.is_numeric_dtype(new[col]):
            new[col] = new[col].fillna(new[col].median())
        elif method == "mode":
            mode = new[col].mode()
            if len(mode):
                new[col] = new[col].fillna(mode.iloc[0])
        elif method == "ffill":
            new[col] = new[col].ffill()
        elif method == "bfill":
            new[col] = new[col].bfill()
        else:
            new[col] = new[col].fillna(value)
    return new, f"Filled missing values in {len(targets)} column(s) using '{method}'."


def op_drop_columns(df, columns=None, **_):
    cols = [c for c in (columns or []) if c in df.columns]
    new = df.drop(columns=cols)
    return new, f"Dropped column(s): {', '.join(cols) if cols else 'none'}."


def op_rename_column(df, old=None, new=None, **_):
    if old not in df.columns:
        return df, f"Column '{old}' not found."
    out = df.rename(columns={old: new})
    return out, f"Renamed '{old}' to '{new}'."


def op_change_type(df, column=None, to=None, **_):
    if column not in df.columns:
        return df, f"Column '{column}' not found."
    new = df.copy()
    try:
        if to in ("int", "integer"):
            new[column] = pd.to_numeric(new[column], errors="coerce").astype("Int64")
        elif to in ("float", "number"):
            new[column] = pd.to_numeric(new[column], errors="coerce")
        elif to in ("str", "string", "text"):
            new[column] = new[column].astype(str)
        elif to in ("datetime", "date"):
            new[column] = pd.to_datetime(new[column], errors="coerce")
        else:
            return df, f"Unknown target type '{to}'."
    except Exception as exc:  # pragma: no cover
        return df, f"Could not convert '{column}': {exc}"
    return new, f"Converted '{column}' to {to}."


def op_strip_whitespace(df, columns=None, **_):
    new = df.copy()
    targets = columns or [c for c in df.columns if df[c].dtype == object]
    for col in targets:
        if col in new.columns and new[col].dtype == object:
            new[col] = new[col].astype(str).str.strip()
    return new, f"Trimmed whitespace in {len(targets)} column(s)."


def op_to_lowercase(df, columns=None, **_):
    new = df.copy()
    targets = columns or [c for c in df.columns if df[c].dtype == object]
    for col in targets:
        if col in new.columns and new[col].dtype == object:
            new[col] = new[col].astype(str).str.lower()
    return new, f"Lower-cased {len(targets)} text column(s)."


def op_filter_rows(df, column=None, operator="==", value=None, **_):
    if column not in df.columns:
        return df, f"Column '{column}' not found."
    s = df[column]
    try:
        if operator in ("==", "eq"):
            mask = s == value
        elif operator in ("!=", "ne"):
            mask = s != value
        elif operator in (">", "gt"):
            mask = pd.to_numeric(s, errors="coerce") > float(value)
        elif operator in (">=", "ge"):
            mask = pd.to_numeric(s, errors="coerce") >= float(value)
        elif operator in ("<", "lt"):
            mask = pd.to_numeric(s, errors="coerce") < float(value)
        elif operator in ("<=", "le"):
            mask = pd.to_numeric(s, errors="coerce") <= float(value)
        elif operator == "contains":
            mask = s.astype(str).str.contains(str(value), case=False, na=False)
        else:
            return df, f"Unknown operator '{operator}'."
    except Exception as exc:
        return df, f"Filter failed: {exc}"
    new = df[mask.fillna(False)]
    return new, f"Kept {len(new)} row(s) where {column} {operator} {value}."


def op_sort(df, column=None, ascending=True, **_):
    if column not in df.columns:
        return df, f"Column '{column}' not found."
    new = df.sort_values(by=column, ascending=bool(ascending))
    return new, f"Sorted by '{column}' ({'asc' if ascending else 'desc'})."


def op_replace_values(df, column=None, find=None, replace=None, **_):
    new = df.copy()
    if column and column in new.columns:
        new[column] = new[column].replace(find, replace)
        scope = f"column '{column}'"
    else:
        new = new.replace(find, replace)
        scope = "all columns"
    return new, f"Replaced '{find}' with '{replace}' in {scope}."


def op_edit_cell(df, row=None, column=None, value=None, **_):
    new = df.copy()
    if column not in new.columns:
        return df, f"Column '{column}' not found."
    try:
        new.iat[int(row), new.columns.get_loc(column)] = value
    except Exception as exc:
        return df, f"Could not edit cell: {exc}"
    return new, f"Updated cell [{row}, {column}]."


def op_add_row(df, values=None, **_):
    new = df.copy()
    row = {c: (values or {}).get(c) for c in new.columns}
    new = pd.concat([new, pd.DataFrame([row])], ignore_index=True)
    return new, "Added a new row."


def op_delete_row(df, row=None, **_):
    try:
        new = df.drop(df.index[int(row)]).reset_index(drop=True)
    except Exception as exc:
        return df, f"Could not delete row: {exc}"
    return new, f"Deleted row {row}."


# Registry: maps an operation name -> handler function.
OPERATIONS = {
    "remove_null_rows": op_remove_null_rows,
    "remove_null_columns": op_remove_null_columns,
    "remove_duplicates": op_remove_duplicates,
    "fill_missing": op_fill_missing,
    "drop_columns": op_drop_columns,
    "rename_column": op_rename_column,
    "change_type": op_change_type,
    "strip_whitespace": op_strip_whitespace,
    "to_lowercase": op_to_lowercase,
    "filter_rows": op_filter_rows,
    "sort": op_sort,
    "replace_values": op_replace_values,
    "edit_cell": op_edit_cell,
    "add_row": op_add_row,
    "delete_row": op_delete_row,
}


def apply_operation(df: pd.DataFrame, name: str, params: dict):
    """Dispatch an operation by name. Returns (new_df, message)."""
    handler = OPERATIONS.get(name)
    if handler is None:
        return df, f"Unknown operation '{name}'."
    params = params or {}
    return handler(df, **params)


# --------------------------------------------------------------------------- #
#  Dashboard recommendation engine
# --------------------------------------------------------------------------- #
def recommend_charts(df: pd.DataFrame, max_recommendations: int = 8) -> list[dict]:
    """
    Heuristically score which charts best fit the dataset.
    Returns a list of chart specs sorted by a suitability score (0-100).
    """
    prof = profile(df)
    cols = prof["columns"]
    numeric = [c for c in cols if c["kind"] == "numeric"]
    categorical = [c for c in cols if c["kind"] == "categorical"]
    datetime_cols = [c for c in cols if c["kind"] == "datetime"]
    n_rows = prof["total_rows"]

    recs: list[dict] = []

    # Low-cardinality categoricals are great for pie / bar breakdowns.
    for cat in categorical:
        if 2 <= cat["unique"] <= 12:
            score = 90 - abs(cat["unique"] - 5) * 3
            recs.append(
                {
                    "type": "pie",
                    "title": f"Distribution of {cat['name']}",
                    "x": cat["name"],
                    "y": None,
                    "agg": "count",
                    "score": max(60, score),
                    "reason": f"'{cat['name']}' has {cat['unique']} categories — ideal for a proportional breakdown.",
                }
            )
        if 2 <= cat["unique"] <= 30:
            recs.append(
                {
                    "type": "bar",
                    "title": f"Count by {cat['name']}",
                    "x": cat["name"],
                    "y": None,
                    "agg": "count",
                    "score": 85 if cat["unique"] <= 15 else 70,
                    "reason": f"Compare frequency across {cat['unique']} categories of '{cat['name']}'.",
                }
            )

    # Categorical + numeric -> aggregated bar chart.
    for cat in categorical:
        if 2 <= cat["unique"] <= 30:
            for num in numeric[:2]:
                recs.append(
                    {
                        "type": "bar",
                        "title": f"Average {num['name']} by {cat['name']}",
                        "x": cat["name"],
                        "y": num["name"],
                        "agg": "mean",
                        "score": 80,
                        "reason": f"See how '{num['name']}' varies across '{cat['name']}'.",
                    }
                )

    # Datetime + numeric -> line (trend).
    for dt in datetime_cols:
        for num in numeric[:2]:
            recs.append(
                {
                    "type": "line",
                    "title": f"{num['name']} over {dt['name']}",
                    "x": dt["name"],
                    "y": num["name"],
                    "agg": "sum",
                    "score": 92,
                    "reason": f"Time series: track '{num['name']}' across '{dt['name']}'.",
                }
            )

    # Two numerics -> scatter (correlation).
    if len(numeric) >= 2:
        recs.append(
            {
                "type": "scatter",
                "title": f"{numeric[0]['name']} vs {numeric[1]['name']}",
                "x": numeric[0]["name"],
                "y": numeric[1]["name"],
                "agg": "none",
                "score": 78,
                "reason": "Explore the relationship / correlation between two numeric fields.",
            }
        )

    # Single numeric -> histogram distribution.
    for num in numeric[:3]:
        recs.append(
            {
                "type": "histogram",
                "title": f"Distribution of {num['name']}",
                "x": num["name"],
                "y": None,
                "agg": "count",
                "score": 72,
                "reason": f"Understand the spread of '{num['name']}'.",
            }
        )

    # De-duplicate by (type,x,y) keeping the highest score.
    best: dict[tuple, dict] = {}
    for r in recs:
        key = (r["type"], r["x"], r["y"])
        if key not in best or r["score"] > best[key]["score"]:
            best[key] = r

    ranked = sorted(best.values(), key=lambda r: r["score"], reverse=True)
    return ranked[:max_recommendations]


def apply_filters(df: pd.DataFrame, filters: list | None) -> pd.DataFrame:
    """Apply slicer filters: [{column, values}] keeps rows whose column value is in values."""
    if not filters:
        return df
    out = df
    for f in filters:
        col = f.get("column")
        vals = f.get("values") or []
        if col in out.columns and vals:
            out = out[out[col].astype(str).isin([str(v) for v in vals])]
    return out


def column_values(df: pd.DataFrame, column: str, limit: int = 200) -> list:
    """Distinct values of a column (as strings) for slicer options."""
    if column not in df.columns:
        return []
    vals = df[column].dropna().astype(str).unique().tolist()
    try:
        vals = sorted(vals, key=lambda v: (float(v) if v.replace(".", "", 1).replace("-", "", 1).isdigit() else float("inf"), v))
    except Exception:
        vals = sorted(vals)
    return vals[:limit]


def kpi_value(df: pd.DataFrame, column: str | None, agg: str = "sum") -> dict:
    """Compute a single KPI value."""
    if agg == "count_rows" or not column:
        return {"value": int(len(df))}
    if column not in df.columns:
        return {"value": None}
    if agg == "count":
        return {"value": int(df[column].notna().sum())}
    if agg == "distinct":
        return {"value": int(df[column].nunique(dropna=True))}
    series = pd.to_numeric(df[column], errors="coerce").dropna()
    if series.empty:
        return {"value": None}
    if agg == "sum":
        val = float(series.sum())
    elif agg == "mean":
        val = float(series.mean())
    elif agg == "max":
        val = float(series.max())
    elif agg == "min":
        val = float(series.min())
    elif agg == "median":
        val = float(series.median())
    else:
        val = float(series.sum())
    return {"value": _json_safe(round(val, 4))}


def pivot_table_data(
    df: pd.DataFrame,
    index: str,
    columns: str | None = None,
    values: str | None = None,
    agg: str = "count",
    max_rows: int = 50,
    max_cols: int = 20,
) -> dict:
    """Build a pivot table and return it as {columns: [...], rows: [[...]]}."""
    if index not in df.columns:
        return {"columns": [], "rows": []}

    aggfunc = {
        "count": "count", "sum": "sum", "mean": "mean",
        "max": "max", "min": "min", "median": "median",
    }.get(agg, "count")

    try:
        if values and values in df.columns:
            if columns and columns in df.columns:
                pt = pd.pivot_table(df, index=index, columns=columns, values=values, aggfunc=aggfunc)
            else:
                pt = df.groupby(index)[values].agg(aggfunc).to_frame(f"{agg} of {values}")
        else:
            if columns and columns in df.columns:
                pt = pd.pivot_table(df, index=index, columns=columns, aggfunc="size").fillna(0)
                if isinstance(pt, pd.Series):
                    pt = pt.to_frame("count")
            else:
                pt = df.groupby(index).size().to_frame("count")
    except Exception:
        return {"columns": [], "rows": []}

    pt = pt.head(max_rows)
    pt = pt.iloc[:, :max_cols]

    header = [str(index)] + [str(c) for c in pt.columns.tolist()]
    rows = []
    for idx, record in zip(pt.index.tolist(), pt.itertuples(index=False, name=None)):
        cells = [str(_json_safe(idx))]
        for v in record:
            sv = _json_safe(v)
            if isinstance(sv, float):
                sv = round(sv, 3)
            cells.append(sv)
        rows.append(cells)
    return {"columns": header, "rows": rows}


# --------------------------------------------------------------------------- #
#  AI-powered insights (anomalies / outliers / trends)
# --------------------------------------------------------------------------- #
def generate_insights(df: pd.DataFrame, max_insights: int = 12) -> list[dict]:
    """Scan the dataset and surface anomalies, outliers, and trends."""
    insights: list[dict] = []
    n = len(df)
    if n == 0:
        return insights

    prof = profile(df)
    numeric_cols = [c["name"] for c in prof["columns"] if c["kind"] == "numeric"]
    cat_cols = [c["name"] for c in prof["columns"] if c["kind"] == "categorical"]
    dt_cols = [c["name"] for c in prof["columns"] if c["kind"] == "datetime"]

    # Missing-data hotspots.
    for c in prof["columns"]:
        if c["missing_pct"] >= 20:
            insights.append({
                "id": f"missing-{c['name']}",
                "type": "missing_data",
                "severity": "critical" if c["missing_pct"] >= 50 else "warning",
                "title": f"High missing data in '{c['name']}'",
                "description": f"{c['missing_pct']}% of values are missing ({c['missing']} of {n} rows).",
                "column": c["name"],
            })

    # Duplicate rows.
    if prof["duplicate_rows"] > 0:
        pct = round(prof["duplicate_rows"] / max(n, 1) * 100, 1)
        insights.append({
            "id": "duplicates",
            "type": "duplicates",
            "severity": "warning" if pct < 10 else "critical",
            "title": "Duplicate rows detected",
            "description": f"{prof['duplicate_rows']} duplicate row(s) found ({pct}% of the dataset).",
            "column": None,
        })

    # Outliers via IQR + skew, per numeric column.
    for col in numeric_cols:
        series = pd.to_numeric(df[col], errors="coerce").dropna()
        if len(series) < 8:
            continue
        q1, q3 = series.quantile(0.25), series.quantile(0.75)
        iqr = q3 - q1
        if iqr == 0:
            continue
        lo, hi = q1 - 1.5 * iqr, q3 + 1.5 * iqr
        outliers = series[(series < lo) | (series > hi)]
        pct = round(len(outliers) / len(series) * 100, 1)
        if pct >= 1:
            insights.append({
                "id": f"outliers-{col}",
                "type": "outlier",
                "severity": "warning" if pct < 8 else "critical",
                "title": f"Outliers detected in '{col}'",
                "description": f"{len(outliers)} value(s) ({pct}%) fall outside the normal range [{round(lo,2)}, {round(hi,2)}].",
                "column": col,
            })
        try:
            skew = float(series.skew())
        except Exception:
            skew = 0
        if abs(skew) >= 1.5:
            direction = "right (high values)" if skew > 0 else "left (low values)"
            insights.append({
                "id": f"skew-{col}",
                "type": "skew",
                "severity": "info",
                "title": f"'{col}' is heavily skewed",
                "description": f"Distribution is skewed to the {direction} (skewness={round(skew,2)}).",
                "column": col,
            })

    # Dominant category concentration.
    for col in cat_cols:
        vc = df[col].dropna().astype(str).value_counts()
        if len(vc) == 0:
            continue
        top_pct = round(vc.iloc[0] / vc.sum() * 100, 1)
        if top_pct >= 60 and len(vc) > 1:
            insights.append({
                "id": f"dominant-{col}",
                "type": "dominant_category",
                "severity": "info",
                "title": f"'{col}' is dominated by one value",
                "description": f"'{vc.index[0]}' accounts for {top_pct}% of all rows in '{col}'.",
                "column": col,
            })

    # High correlation pairs.
    if len(numeric_cols) >= 2:
        try:
            corr = df[numeric_cols].corr(numeric_only=True)
            seen = set()
            for c1 in numeric_cols:
                for c2 in numeric_cols:
                    if c1 == c2 or (c2, c1) in seen:
                        continue
                    seen.add((c1, c2))
                    val = corr.loc[c1, c2]
                    if pd.notna(val) and abs(val) >= 0.8:
                        insights.append({
                            "id": f"corr-{c1}-{c2}",
                            "type": "correlation",
                            "severity": "info",
                            "title": f"Strong correlation: '{c1}' & '{c2}'",
                            "description": f"Correlation coefficient of {round(float(val), 2)} suggests a strong "
                                            f"{'positive' if val > 0 else 'negative'} relationship.",
                            "column": None,
                        })
        except Exception:
            pass

    # Trend detection (datetime + numeric).
    for dtc in dt_cols:
        try:
            dts = pd.to_datetime(df[dtc], errors="coerce")
        except Exception:
            continue
        for num in numeric_cols[:3]:
            sub = pd.DataFrame({"_t": dts, "_v": pd.to_numeric(df[num], errors="coerce")}).dropna()
            if len(sub) < 5:
                continue
            sub = sub.sort_values("_t")
            half = len(sub) // 2
            first_mean = sub["_v"].iloc[:half].mean()
            second_mean = sub["_v"].iloc[half:].mean()
            if first_mean == 0:
                continue
            change = round((second_mean - first_mean) / abs(first_mean) * 100, 1)
            if abs(change) >= 15:
                direction = "increasing" if change > 0 else "decreasing"
                insights.append({
                    "id": f"trend-{dtc}-{num}",
                    "type": "trend",
                    "severity": "info",
                    "title": f"'{num}' is {direction} over time",
                    "description": f"Average '{num}' changed by {change}% between the earlier and later half of '{dtc}'.",
                    "column": num,
                })

    return insights[:max_insights]


# --------------------------------------------------------------------------- #
#  Schema auto-detection & cast suggestions
# --------------------------------------------------------------------------- #
def schema_suggestions(df: pd.DataFrame) -> list[dict]:
    """Detect columns that look like dates, currencies, or low-cardinality
    categories and suggest a type conversion."""
    suggestions = []
    n = len(df)
    if n == 0:
        return suggestions

    for col in df.columns:
        series = df[col]
        if pd.api.types.is_numeric_dtype(series) or pd.api.types.is_datetime64_any_dtype(series):
            continue
        text = series.dropna().astype(str)
        if text.empty:
            continue
        sample = text.head(5).tolist()

        # Currency: values containing currency symbols or thousands separators.
        currency_pattern = text.str.match(r"^\s*[\$€£₹]\s*-?[\d,]+\.?\d*\s*$")
        if currency_pattern.mean() >= 0.7:
            suggestions.append({
                "column": str(col),
                "current_dtype": str(series.dtype),
                "suggested_type": "currency (float)",
                "reason": "Values contain currency symbols (e.g. $, €, £) — convert to numeric for aggregation.",
                "sample": sample,
                "action": "cast_currency",
            })
            continue

        # Datetime-like text.
        try:
            parsed = pd.to_datetime(text, errors="coerce")
            parse_rate = parsed.notna().mean()
        except Exception:
            parse_rate = 0
        if parse_rate >= 0.8:
            suggestions.append({
                "column": str(col),
                "current_dtype": str(series.dtype),
                "suggested_type": "datetime",
                "reason": f"{round(parse_rate*100)}% of values parse as valid dates.",
                "sample": sample,
                "action": "cast_datetime",
            })
            continue

        # Numeric-looking text.
        numeric_parsed = pd.to_numeric(text.str.replace(",", "", regex=False), errors="coerce")
        if numeric_parsed.notna().mean() >= 0.9:
            suggestions.append({
                "column": str(col),
                "current_dtype": str(series.dtype),
                "suggested_type": "number",
                "reason": "Values look numeric but are stored as text.",
                "sample": sample,
                "action": "cast_number",
            })
            continue

        # Low-cardinality category.
        nunique = series.nunique(dropna=True)
        if nunique > 1 and nunique / n <= 0.05:
            suggestions.append({
                "column": str(col),
                "current_dtype": str(series.dtype),
                "suggested_type": "category",
                "reason": f"Only {nunique} distinct values across {n} rows — store as category to save memory & speed up grouping.",
                "sample": sample,
                "action": "cast_category",
            })

    return suggestions


def apply_schema_suggestion(df: pd.DataFrame, column: str, action: str):
    """Apply a suggested cast for a column. Returns (new_df, message)."""
    if column not in df.columns:
        return df, f"Column '{column}' not found."
    new = df.copy()
    try:
        if action == "cast_currency":
            new[column] = pd.to_numeric(
                new[column].astype(str).str.replace(r"[^\d.\-]", "", regex=True), errors="coerce"
            )
            return new, f"Converted '{column}' from currency text to numeric."
        if action == "cast_datetime":
            new[column] = pd.to_datetime(new[column], errors="coerce")
            return new, f"Converted '{column}' to datetime."
        if action == "cast_number":
            new[column] = pd.to_numeric(new[column].astype(str).str.replace(",", "", regex=False), errors="coerce")
            return new, f"Converted '{column}' to numeric."
        if action == "cast_category":
            new[column] = new[column].astype("category")
            return new, f"Converted '{column}' to category."
    except Exception as exc:
        return df, f"Could not convert '{column}': {exc}"
    return df, f"Unknown action '{action}'."


# --------------------------------------------------------------------------- #
#  Multi-file relationship detection & merge
# --------------------------------------------------------------------------- #
def detect_relationships(df1: pd.DataFrame, df2: pd.DataFrame, max_results: int = 8) -> list[dict]:
    """Suggest likely join keys between two DataFrames based on column-name
    similarity and value overlap."""
    import difflib

    results = []
    for c1 in df1.columns:
        s1 = df1[c1].dropna().astype(str)
        if s1.empty:
            continue
        set1 = set(s1.unique().tolist()[:2000])
        for c2 in df2.columns:
            s2 = df2[c2].dropna().astype(str)
            if s2.empty:
                continue
            name_sim = difflib.SequenceMatcher(None, str(c1).lower(), str(c2).lower()).ratio()
            set2 = set(s2.unique().tolist()[:2000])
            if not set1 or not set2:
                continue
            overlap = len(set1 & set2) / max(1, min(len(set1), len(set2)))
            score = round((name_sim * 0.4 + overlap * 0.6) * 100, 1)
            if score >= 30:
                results.append({
                    "left": str(c1),
                    "right": str(c2),
                    "score": score,
                    "name_similarity": round(name_sim * 100, 1),
                    "value_overlap": round(overlap * 100, 1),
                })
    results.sort(key=lambda r: r["score"], reverse=True)
    return results[:max_results]


def merge_dataframes(df1: pd.DataFrame, df2: pd.DataFrame, left_on: str, right_on: str, how: str = "inner"):
    if left_on not in df1.columns or right_on not in df2.columns:
        return df1, "Join key not found in one of the datasets."
    try:
        merged = df1.merge(df2, left_on=left_on, right_on=right_on, how=how, suffixes=("", "_2"))
    except Exception as exc:
        return df1, f"Merge failed: {exc}"
    return merged, f"Merged datasets on '{left_on}' ↔ '{right_on}' ({how} join) — {len(merged)} row(s)."


# --------------------------------------------------------------------------- #
#  Geo-map detection & aggregation
# --------------------------------------------------------------------------- #
_GEO_KEYWORDS = ("country", "nation", "state", "province", "region", "territory", "city")

_COUNTRY_HINTS = {
    "united states", "usa", "india", "china", "germany", "france", "brazil", "canada",
    "australia", "japan", "russia", "mexico", "italy", "spain", "uk", "united kingdom",
}


def geo_columns(df: pd.DataFrame) -> list[str]:
    """Detect columns that likely represent countries/states/regions."""
    found = []
    for col in df.columns:
        name = str(col).lower()
        if any(k in name for k in _GEO_KEYWORDS):
            found.append(str(col))
            continue
        if df[col].dtype == object:
            sample = df[col].dropna().astype(str).str.lower().head(50)
            if len(sample) and sample.isin(_COUNTRY_HINTS).mean() >= 0.15:
                found.append(str(col))
    return found


def geo_aggregate(df: pd.DataFrame, region_col: str, value_col: str | None, agg: str = "count", max_regions: int = 60) -> dict:
    if region_col not in df.columns:
        return {"regions": []}
    if value_col and value_col in df.columns and agg != "count":
        grouped = df.groupby(region_col, dropna=True)[value_col]
        result = getattr(grouped, agg, grouped.sum)()
    else:
        result = df.groupby(region_col, dropna=True).size()
    result = result.sort_values(ascending=False).head(max_regions)
    total = float(result.sum()) or 1.0
    regions = [
        {
            "name": str(_json_safe(idx)),
            "value": _json_safe(round(float(val), 3)),
            "pct": round(float(val) / total * 100, 2),
        }
        for idx, val in result.items()
    ]
    return {"regions": regions}


# --------------------------------------------------------------------------- #
#  Power BI-style visual payloads (series / stacked / combo / waterfall …)
# --------------------------------------------------------------------------- #
#  Visual types that support a legend (series) breakdown.
SERIES_VISUALS = {
    "stacked_bar", "stacked_column", "clustered_bar", "clustered_column",
    "ribbon", "area", "stacked_area", "line", "line_stacked_column", "bar",
}
#  Visual types that only need a single labels/values pair.
SINGLE_VISUALS = {"pie", "donut", "doughnut", "treemap", "funnel", "histogram"}

_AGG_NAMES = {"count": "count", "sum": "sum", "mean": "mean",
              "max": "max", "min": "min", "median": "median"}


def _agg_group(df: pd.DataFrame, keys, y: str | None, agg: str):
    """Group by `keys` and aggregate `y` (or row-count when y/agg is count)."""
    if y and y in df.columns and agg != "count":
        grouped = df.groupby(keys, dropna=True)[y]
        return getattr(grouped, _AGG_NAMES.get(agg, "sum"))()
    return df.groupby(keys, dropna=True).size()


def chart_payload(
    df: pd.DataFrame,
    chart_type: str,
    x: str | None,
    y: str | None = None,
    agg: str = "count",
    series: str | None = None,
    y2: str | None = None,
    agg2: str | None = None,
    max_categories: int = 30,
    max_series: int = 12,
) -> dict:
    """Build a Chart.js-ready payload for any of the supported visual types.

    Returns one of:
      {"labels": [...], "values": [...]}                       – single measure
      {"labels": [...], "series": [{"name","values"}, ...]}    – legend breakdown
      {"labels": [...], "values": [...], "ranges": [[s,e],...]} – waterfall
      {"points": [{"x","y"}, ...]}                             – scatter
    """
    if not x or x not in df.columns:
        return {"labels": [], "values": []}

    if chart_type == "scatter":
        return aggregate_for_chart(df, "scatter", x, y, agg)
    if chart_type == "histogram":
        return aggregate_for_chart(df, "histogram", x, y, agg)

    # ---- Waterfall: sequential contributions + running total ranges -------- #
    if chart_type == "waterfall":
        result = _agg_group(df, x, y, agg).head(max_categories)
        labels = [str(_json_safe(i)) for i in result.index.tolist()]
        values = [float(v or 0) for v in result.tolist()]
        ranges, running = [], 0.0
        for v in values:
            ranges.append([round(running, 4), round(running + v, 4)])
            running += v
        return {
            "labels": labels + ["Total"],
            "values": [round(v, 4) for v in values] + [round(running, 4)],
            "ranges": ranges + [[0, round(running, 4)]],
        }

    # ---- Legend / series breakdown (stacked, clustered, ribbon, combo) ----- #
    if series and series in df.columns and chart_type in SERIES_VISUALS:
        try:
            grouped = _agg_group(df, [x, series], y, agg)
            table = grouped.unstack(fill_value=0)
        except Exception:
            table = None
        if table is not None and not table.empty:
            # Keep the biggest categories and the biggest series.
            order = table.sum(axis=1).sort_values(ascending=False)
            if chart_type in ("line", "area", "stacked_area", "line_stacked_column"):
                table = table.loc[sorted(table.index.tolist(), key=str)]
            else:
                table = table.loc[order.index]
            table = table.head(max_categories)
            top_series = table.sum(axis=0).sort_values(ascending=False).head(max_series).index
            table = table[top_series]

            payload = {
                "labels": [str(_json_safe(i)) for i in table.index.tolist()],
                "series": [
                    {
                        "name": str(_json_safe(col)),
                        "values": [_json_safe(round(float(v or 0), 4)) for v in table[col].tolist()],
                    }
                    for col in table.columns
                ],
            }
            if chart_type == "line_stacked_column" and y2 and y2 in df.columns:
                line_res = _agg_group(df, x, y2, agg2 or "sum").reindex(table.index, fill_value=0)
                payload["line_values"] = [_json_safe(round(float(v or 0), 4)) for v in line_res.tolist()]
                payload["line_label"] = f"{agg2 or 'sum'} of {y2}"
            return payload

    # ---- Single measure ---------------------------------------------------- #
    result = _agg_group(df, x, y, agg)
    if chart_type in ("line", "area", "stacked_area", "line_stacked_column"):
        result = result.sort_index(key=lambda idx: idx.astype(str))
    else:
        result = result.sort_values(ascending=False)
    result = result.head(max_categories)

    payload = {
        "labels": [str(_json_safe(i)) for i in result.index.tolist()],
        "values": [_json_safe(round(float(v or 0), 4)) for v in result.tolist()],
    }
    if chart_type == "line_stacked_column" and y2 and y2 in df.columns:
        line_res = _agg_group(df, x, y2, agg2 or "sum").reindex(result.index, fill_value=0)
        payload["line_values"] = [_json_safe(round(float(v or 0), 4)) for v in line_res.tolist()]
        payload["line_label"] = f"{agg2 or 'sum'} of {y2}"
    return payload


def aggregate_for_chart(
    df: pd.DataFrame, chart_type: str, x: str, y: str | None, agg: str = "count"
) -> dict:
    """Produce {labels, values} (or points) ready for Chart.js."""
    if x not in df.columns:
        return {"labels": [], "values": []}

    if chart_type == "scatter":
        if not y or y not in df.columns:
            return {"points": []}
        sub = df[[x, y]].dropna()
        # .iloc keeps this safe when x and y are the same column.
        pts = [
            {"x": _json_safe(a), "y": _json_safe(b)}
            for a, b in zip(sub.iloc[:, 0].tolist(), sub.iloc[:, 1].tolist())
        ][:2000]
        return {"points": pts}

    if chart_type == "histogram":
        series = pd.to_numeric(df[x], errors="coerce").dropna()
        if series.empty:
            return {"labels": [], "values": []}
        counts, edges = np.histogram(series, bins=min(20, max(5, series.nunique())))
        labels = [f"{round(edges[i],2)}–{round(edges[i+1],2)}" for i in range(len(counts))]
        return {"labels": labels, "values": [int(c) for c in counts]}

    # pie / bar / line -> group by x.
    if y and y in df.columns and agg != "count":
        grouped = df.groupby(x, dropna=True)[y]
        if agg == "sum":
            result = grouped.sum()
        elif agg == "mean":
            result = grouped.mean()
        elif agg == "max":
            result = grouped.max()
        elif agg == "min":
            result = grouped.min()
        elif agg == "median":
            result = grouped.median()
        else:
            result = grouped.count()
    else:
        result = df.groupby(x, dropna=True).size()

    if chart_type != "line":
        result = result.sort_values(ascending=False)
    result = result.head(30)

    labels = [str(_json_safe(i)) for i in result.index.tolist()]
    values = [_json_safe(round(float(v), 4)) if v is not None else 0 for v in result.tolist()]
    return {"labels": labels, "values": values}
