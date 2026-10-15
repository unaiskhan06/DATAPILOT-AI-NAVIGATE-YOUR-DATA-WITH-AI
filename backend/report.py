"""
report.py
Export helpers for DataPilot AI: branded PDF profiling reports and
PowerPoint-style slide-deck exports of dashboard charts/KPIs.
"""
from __future__ import annotations

import base64
import io
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LOGO_PATH = os.path.join(os.path.dirname(BASE_DIR), "Images", "DataPilot AI Logo.png")


# --------------------------------------------------------------------------- #
#  PDF profiling report (reportlab)
# --------------------------------------------------------------------------- #
def build_profile_pdf(filename: str, profile: dict, insights: list[dict], story: str) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import cm
    from reportlab.platypus import (
        Image,
        PageBreak,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        topMargin=1.6 * cm, bottomMargin=1.6 * cm, leftMargin=1.6 * cm, rightMargin=1.6 * cm,
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("dp_title", parent=styles["Title"], textColor=colors.HexColor("#5b3df0"))
    h2 = ParagraphStyle("dp_h2", parent=styles["Heading2"], textColor=colors.HexColor("#2b2350"), spaceBefore=14)
    body = ParagraphStyle("dp_body", parent=styles["BodyText"], leading=16)
    small = ParagraphStyle("dp_small", parent=styles["BodyText"], fontSize=8.5, textColor=colors.grey)

    elements = []
    if os.path.isfile(LOGO_PATH):
        elements.append(Image(LOGO_PATH, width=2.4 * cm, height=2.4 * cm))
        elements.append(Spacer(1, 8))
    elements.append(Paragraph("DataPilot AI — Dataset Profiling Report", title_style))
    elements.append(Paragraph(f"Dataset: {filename}", small))
    elements.append(Spacer(1, 16))

    elements.append(Paragraph("Overview", h2))
    overview_rows = [
        ["Rows", str(profile.get("total_rows", 0))],
        ["Columns", str(profile.get("total_cols", 0))],
        ["Missing values", str(profile.get("total_missing", 0))],
        ["Duplicate rows", str(profile.get("duplicate_rows", 0))],
        ["Memory (KB)", str(profile.get("memory_kb", 0))],
    ]
    t = Table(overview_rows, colWidths=[6 * cm, 6 * cm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#efe9ff")),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#d9d2f5")),
        ("FONTSIZE", (0, 0), (-1, -1), 9.5),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    elements.append(t)
    elements.append(Spacer(1, 14))

    if story:
        elements.append(Paragraph("Data Story", h2))
        for para in story.split("\n\n"):
            if para.strip():
                elements.append(Paragraph(para.strip(), body))
                elements.append(Spacer(1, 6))

    if insights:
        elements.append(Paragraph("Automated Insights", h2))
        for ins in insights:
            sev = ins.get("severity", "info").upper()
            color = {"CRITICAL": "#d64545", "WARNING": "#d99a2b", "INFO": "#4a6fd9"}.get(sev, "#4a6fd9")
            elements.append(Paragraph(
                f'<font color="{color}"><b>[{sev}]</b></font> <b>{ins.get("title","")}</b> — {ins.get("description","")}',
                body,
            ))
            elements.append(Spacer(1, 4))

    elements.append(PageBreak())
    elements.append(Paragraph("Column Details", h2))
    header = ["Column", "Type", "Missing %", "Unique", "Extra"]
    rows = [header]
    for c in profile.get("columns", []):
        extra = ""
        if c.get("kind") == "numeric":
            extra = f"min {c.get('min')} · max {c.get('max')} · mean {c.get('mean')}"
        rows.append([c.get("name", ""), c.get("kind", ""), f"{c.get('missing_pct', 0)}%", str(c.get("unique", 0)), extra])
    ct = Table(rows, colWidths=[3.6 * cm, 2.4 * cm, 2.2 * cm, 2 * cm, 6.5 * cm], repeatRows=1)
    ct.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#5b3df0")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#e0dcf5")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f7f5ff")]),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    elements.append(ct)

    doc.build(elements)
    buf.seek(0)
    return buf.read()


# --------------------------------------------------------------------------- #
#  PPTX slide-deck export (python-pptx)
# --------------------------------------------------------------------------- #
def build_pptx(title: str, slides: list[dict], logo: str | None = None) -> bytes:
    """
    slides: [{ "title": str, "image": "data:image/png;base64,....", "kind": "chart"|"kpi",
               "value": optional str (for kpi cards) }]
    logo: optional "data:image/png;base64,...." — the user's own dataset logo,
          stamped at the top-left corner of every slide.
    """
    from pptx import Presentation
    from pptx.util import Inches, Pt
    from pptx.dml.color import RGBColor

    prs = Presentation()
    prs.slide_width = Inches(13.33)
    prs.slide_height = Inches(7.5)
    blank = prs.slide_layouts[6]

    logo_stream = None
    if logo and "," in logo:
        try:
            logo_stream = base64.b64decode(logo.split(",", 1)[1])
        except Exception:
            logo_stream = None

    def stamp_logo(slide):
        if logo_stream:
            slide.shapes.add_picture(io.BytesIO(logo_stream), Inches(0.35), Inches(0.3), height=Inches(0.7))

    # Title slide.
    slide = prs.slides.add_slide(blank)
    box = slide.shapes.add_textbox(Inches(1), Inches(2.8), Inches(11.3), Inches(1.5))
    tf = box.text_frame
    tf.text = title or "DataPilot AI Dashboard"
    tf.paragraphs[0].font.size = Pt(40)
    tf.paragraphs[0].font.bold = True
    tf.paragraphs[0].font.color.rgb = RGBColor(0x5B, 0x3D, 0xF0)
    if os.path.isfile(LOGO_PATH):
        slide.shapes.add_picture(LOGO_PATH, Inches(5.9), Inches(1.1), height=Inches(1.3))
    stamp_logo(slide)

    # When a logo is stamped top-left, indent the slide title so the two
    # don't overlap.
    title_x = Inches(1.6) if logo_stream else Inches(0.5)
    title_w = Inches(11.2) if logo_stream else Inches(12.3)

    for s in slides:
        slide = prs.slides.add_slide(blank)
        stamp_logo(slide)
        title_box = slide.shapes.add_textbox(title_x, Inches(0.35), title_w, Inches(0.8))
        title_box.text_frame.text = s.get("title", "")
        title_box.text_frame.paragraphs[0].font.size = Pt(28)
        title_box.text_frame.paragraphs[0].font.bold = True
        title_box.text_frame.paragraphs[0].font.color.rgb = RGBColor(0x2B, 0x23, 0x50)

        img_data = s.get("image")
        if img_data and "," in img_data:
            raw = base64.b64decode(img_data.split(",", 1)[1])
            img_stream = io.BytesIO(raw)
            if s.get("kind") == "kpi":
                slide.shapes.add_picture(img_stream, Inches(3.5), Inches(1.6), height=Inches(4.5))
            else:
                slide.shapes.add_picture(img_stream, Inches(1.0), Inches(1.3), width=Inches(11.3))
        elif s.get("value") is not None:
            val_box = slide.shapes.add_textbox(Inches(2), Inches(3), Inches(9.3), Inches(2))
            val_box.text_frame.text = str(s.get("value"))
            val_box.text_frame.paragraphs[0].font.size = Pt(60)
            val_box.text_frame.paragraphs[0].font.bold = True
            val_box.text_frame.paragraphs[0].font.color.rgb = RGBColor(0x5B, 0x3D, 0xF0)

    buf = io.BytesIO()
    prs.save(buf)
    buf.seek(0)
    return buf.read()
