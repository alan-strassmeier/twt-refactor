from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[3]
OUTPUT = ROOT / "output" / "pdf" / "analise-coleta-7776.pdf"

PAGE_WIDTH, PAGE_HEIGHT = A4
NAVY = colors.HexColor("#17324A")
BLUE = colors.HexColor("#1674C9")
LIGHT_BLUE = colors.HexColor("#EAF4FD")
PALE_BLUE = colors.HexColor("#F4F9FD")
GREEN = colors.HexColor("#197047")
AMBER = colors.HexColor("#9A6700")
RED = colors.HexColor("#B42318")
GREY = colors.HexColor("#5D6B78")
LIGHT_GREY = colors.HexColor("#E2E8EE")
WHITE = colors.white


styles = getSampleStyleSheet()
styles.add(ParagraphStyle(
    name="ReportTitle",
    parent=styles["Title"],
    fontName="Helvetica-Bold",
    fontSize=22,
    leading=26,
    textColor=NAVY,
    alignment=TA_LEFT,
    spaceAfter=5 * mm,
))
styles.add(ParagraphStyle(
    name="Subtitle",
    parent=styles["Normal"],
    fontName="Helvetica",
    fontSize=10,
    leading=14,
    textColor=GREY,
    spaceAfter=5 * mm,
))
styles.add(ParagraphStyle(
    name="Section",
    parent=styles["Heading2"],
    fontName="Helvetica-Bold",
    fontSize=14,
    leading=18,
    textColor=NAVY,
    spaceBefore=4 * mm,
    spaceAfter=3 * mm,
))
styles.add(ParagraphStyle(
    name="BodySmall",
    parent=styles["BodyText"],
    fontSize=8.5,
    leading=11.5,
    textColor=NAVY,
))
styles.add(ParagraphStyle(
    name="Cell",
    parent=styles["BodyText"],
    fontSize=7.6,
    leading=10,
    textColor=NAVY,
))
styles.add(ParagraphStyle(
    name="CellHeader",
    parent=styles["BodyText"],
    fontName="Helvetica-Bold",
    fontSize=7.6,
    leading=10,
    textColor=WHITE,
    alignment=TA_CENTER,
))
styles.add(ParagraphStyle(
    name="Label",
    parent=styles["BodyText"],
    fontName="Helvetica-Bold",
    fontSize=7.5,
    leading=9.5,
    textColor=GREY,
))
styles.add(ParagraphStyle(
    name="Value",
    parent=styles["BodyText"],
    fontSize=9,
    leading=12,
    textColor=NAVY,
))
styles.add(ParagraphStyle(
    name="Message",
    parent=styles["BodyText"],
    fontName="Courier",
    fontSize=7.2,
    leading=9.4,
    textColor=NAVY,
))
styles.add(ParagraphStyle(
    name="Footer",
    parent=styles["Normal"],
    fontSize=7,
    textColor=GREY,
    alignment=TA_CENTER,
))


def p(text, style="Cell"):
    safe = str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return Paragraph(safe, styles[style])


def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LIGHT_GREY)
    canvas.line(18 * mm, 13 * mm, PAGE_WIDTH - 18 * mm, 13 * mm)
    canvas.setFont("Helvetica", 7)
    canvas.setFillColor(GREY)
    canvas.drawCentredString(
        PAGE_WIDTH / 2,
        8.5 * mm,
        f"TWT - Analise do MVP de envio de coletas | Pagina {doc.page}",
    )
    canvas.restoreState()


def info_card(rows):
    table_rows = []
    for left_label, left_value, right_label, right_value in rows:
        table_rows.append([
            p(left_label, "Label"),
            p(left_value or "Nao informado", "Value"),
            p(right_label, "Label"),
            p(right_value or "Nao informado", "Value"),
        ])
    table = Table(table_rows, colWidths=[27 * mm, 58 * mm, 27 * mm, 58 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), PALE_BLUE),
        ("BOX", (0, 0), (-1, -1), 0.6, LIGHT_GREY),
        ("INNERGRID", (0, 0), (-1, -1), 0.35, LIGHT_GREY),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return table


def status_cell(value):
    palette = {
        "SIM": GREEN,
        "PARCIAL": AMBER,
        "NAO": RED,
        "CONFIRMAR": BLUE,
    }
    style = ParagraphStyle(
        name=f"Status{value}",
        parent=styles["Cell"],
        fontName="Helvetica-Bold",
        textColor=palette[value],
        alignment=TA_CENTER,
    )
    return Paragraph(value, style)


doc = BaseDocTemplate(
    str(OUTPUT),
    pagesize=A4,
    rightMargin=18 * mm,
    leftMargin=18 * mm,
    topMargin=16 * mm,
    bottomMargin=18 * mm,
    title="Analise da coleta 7776 para envio via WhatsApp",
    author="TWT",
)
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="main")
doc.addPageTemplates([PageTemplate(id="report", frames=[frame], onPage=footer)])

story = []
story.append(Paragraph("Analise da coleta 7776", styles["ReportTitle"]))
story.append(Paragraph(
    "Referencia para validar o MVP de consulta e envio assistido pelo WhatsApp. "
    "Fontes consideradas: PDF da ordem de coleta, texto de e-mail fornecido e contrato "
    "documentado do GET /operacional/consulta/coleta/{id}.",
    styles["Subtitle"],
))

summary = Table([
    [p("RESULTADO ATUAL", "CellHeader"), p("PONTO DE ATENCAO", "CellHeader")],
    [
        p("O MVP consulta a coleta no backend, monta uma mensagem editavel, permite escolher o contato e abre o WhatsApp para confirmacao manual.", "BodySmall"),
        p("O GET documentado nao garante todos os campos usados no e-mail. Bairro, telefone, solicitante, observacao, servico e trecho precisam ser confirmados no retorno real.", "BodySmall"),
    ],
], colWidths=[85 * mm, 85 * mm])
summary.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), BLUE),
    ("BACKGROUND", (0, 1), (0, 1), colors.HexColor("#E9F7EF")),
    ("BACKGROUND", (1, 1), (1, 1), colors.HexColor("#FFF7E0")),
    ("BOX", (0, 0), (-1, -1), 0.7, LIGHT_GREY),
    ("INNERGRID", (0, 0), (-1, -1), 0.4, LIGHT_GREY),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 8),
    ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ("TOPPADDING", (0, 0), (-1, -1), 7),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
]))
story.append(summary)

story.append(Paragraph("1. Dados consolidados do exemplo", styles["Section"]))
story.append(info_card([
    ("Coleta", "7776", "Solicitante", "CAIO (RESPITEC)"),
    ("Data", "13/08/2026", "Horario", "08:00:00 ate 17:00:00"),
    ("Servico", "DSL - RODO EXPRESS", "Trecho", "CWB / RAO"),
    ("Volumes", "1", "Peso real", "10,00 kg"),
    ("Notas fiscais", "6107", "Valor das notas", "R$ 100.000,00"),
    ("Medidas", "1 volume - 0,32 x 0,38 x 0,42 m", "Data limite", "14/08/2026"),
]))

story.append(Spacer(1, 3 * mm))
story.append(Paragraph("Coleta e entrega", styles["Section"]))
story.append(info_card([
    ("Local coleta", "RESPITEC SOLUCOES INTEGRADAS PARA H ARE LTDA", "Local entrega", "WHITE MARTINS GASES INDUSTRIAIS LTDA - SERTAOZINHO"),
    ("Endereco coleta", "RUA BENITO ANTONIO BALDAN, 182", "Endereco entrega", "AVENIDA MARGINAL SERGIO CANCIAN, 5093"),
    ("Bairro coleta", "PIONEIROS", "Bairro entrega", "SETOR INDUSTRIAL"),
    ("Cidade/UF coleta", "FAZENDA RIO GRANDE - PR", "Cidade/UF entrega", "SERTAOZINHO - SP"),
    ("Telefone coleta", "41 99933-8644", "Telefone entrega", "51 99993-3310"),
    ("Responsavel", "CWB - GVR TRANSPORTES LTDA", "Fone responsavel", "(41) 3382-1717"),
]))

story.append(Paragraph("2. Cobertura do endpoint e lacunas", styles["Section"]))
coverage_rows = [
    [p("Campo", "CellHeader"), p("No PDF/e-mail", "CellHeader"), p("No GET documentado", "CellHeader"), p("Situacao no MVP", "CellHeader"), p("Acao recomendada", "CellHeader")],
    [p("Numero da coleta"), status_cell("SIM"), status_cell("SIM"), status_cell("SIM"), p("Nenhuma")],
    [p("Data e horario"), status_cell("SIM"), status_cell("SIM"), status_cell("SIM"), p("Validar formato do retorno real")],
    [p("Local e endereco de coleta"), status_cell("SIM"), status_cell("SIM"), status_cell("SIM"), p("Nenhuma")],
    [p("Cidade/UF de coleta"), status_cell("SIM"), status_cell("PARCIAL"), status_cell("SIM"), p("GET documenta cidade em um campo; confirmar se UF vem junto")],
    [p("Local e endereco de entrega"), status_cell("SIM"), status_cell("SIM"), status_cell("SIM"), p("Nenhuma")],
    [p("Cidade/UF de entrega"), status_cell("SIM"), status_cell("PARCIAL"), status_cell("SIM"), p("Confirmar se UF vem junto")],
    [p("Volumes e peso"), status_cell("SIM"), status_cell("SIM"), status_cell("SIM"), p("Nenhuma")],
    [p("Solicitante"), status_cell("SIM"), status_cell("NAO"), status_cell("CONFIRMAR"), p("Verificar se a API devolve xSoli/solicitante fora do contrato")],
    [p("Bairros"), status_cell("SIM"), status_cell("NAO"), status_cell("CONFIRMAR"), p("Verificar retorno real ou buscar em outra fonte")],
    [p("Telefones"), status_cell("SIM"), status_cell("NAO"), status_cell("CONFIRMAR"), p("Verificar retorno real ou buscar em outra fonte")],
    [p("Observacao"), status_cell("SIM"), status_cell("NAO"), status_cell("CONFIRMAR"), p("Verificar aliases obs/observacao/xObs")],
    [p("Servico"), status_cell("SIM"), status_cell("NAO"), status_cell("CONFIRMAR"), p("Verificar se retorna nome ou somente codigo")],
    [p("Trecho"), status_cell("SIM"), status_cell("NAO"), status_cell("CONFIRMAR"), p("Verificar retorno real")],
    [p("Cia/transferencia"), status_cell("SIM"), status_cell("PARCIAL"), status_cell("PARCIAL"), p("MVP usa responsavel_coleta como alternativa")],
    [p("Medidas dos volumes"), status_cell("SIM"), status_cell("SIM"), status_cell("NAO"), p("Decidir se devem entrar no texto; hoje ficam apenas no PDF")],
    [p("PDF anexo"), status_cell("SIM"), status_cell("NAO"), status_cell("NAO"), p("No MVP o funcionario anexa manualmente no WhatsApp")],
]
coverage = Table(coverage_rows, repeatRows=1, colWidths=[31 * mm, 21 * mm, 27 * mm, 23 * mm, 68 * mm])
coverage.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), BLUE),
    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, PALE_BLUE]),
    ("BOX", (0, 0), (-1, -1), 0.6, LIGHT_GREY),
    ("INNERGRID", (0, 0), (-1, -1), 0.3, LIGHT_GREY),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 4),
    ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ("TOPPADDING", (0, 0), (-1, -1), 5),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
]))
story.append(coverage)

message = """Prezado, segue abaixo os dados da coleta 7776
Solicitante:
CAIO (RESPITEC)
Data para coleta:
13/08/2026 das 08:00:00 ate as 17:00:00
Local de coleta:
RESPITEC SOLUCOES INTEGRADAS PARA H ARE LTDA
Endereco:
RUA BENITO ANTONIO BALDAN - 182
Bairro:
PIONEIROS
Cidade / Uf:
FAZENDA RIO GRANDE - PR
Telefone:
41999338644
Observacao:

Volumes:
1.00
Peso:
10.00
Cia de embarque / Transferencia:
CWB - GVR TRANSPORTES LTDA
Servico:
DSL - RODO EXPRESS
Trecho:
CWB > RAO
Local de entrega:
WHITE MARTINS GASES INDUSTRIAIS LTDA - SERTAOZINHO
Endereco:
AVENIDA MARGINAL SERGIO CANCIAN - 5093
Bairro:
SETOR INDUSTRIAL
Cidade / Uf:
SERTAOZINHO - SP
Consideracoes gerais:
1. Caso o horario e prazo de coleta nao possam ser atendidos favor nos informar imediatamente.
2. Horario de Coleta, Endereco, Peso, Quantidade e Medidas dos volumes vide coleta em anexo.
3. Assim que concluida a entrega favor informar imediatamente, apos o embarque repassar os dados e custo da coleta imediatamente."""
message_table = Table([[Paragraph(message.replace("\n", "<br/>"), styles["Message"])]], colWidths=[170 * mm], style=TableStyle([
    ("BACKGROUND", (0, 0), (-1, -1), PALE_BLUE),
    ("BOX", (0, 0), (-1, -1), 0.7, LIGHT_GREY),
    ("LEFTPADDING", (0, 0), (-1, -1), 10),
    ("RIGHTPADDING", (0, 0), (-1, -1), 10),
    ("TOPPADDING", (0, 0), (-1, -1), 9),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
]))
story.append(KeepTogether([
    Paragraph("3. Previa da mensagem com as informacoes atuais", styles["Section"]),
    message_table,
]))

story.append(Paragraph("4. Checklist para fechar o MVP", styles["Section"]))
checklist = [
    "Executar uma consulta real da coleta 7776 pelo endpoint da Brudam e guardar apenas uma amostra anonimizada do formato.",
    "Confirmar se solicitante, bairro, telefone, observacao, servico e trecho aparecem como campos extras.",
    "Definir se o responsavel pela coleta deve ocupar 'Cia de embarque / Transferencia'.",
    "Confirmar se o texto deve usar o servico comercial 'DSL - RODO EXPRESS' ou outro nome operacional.",
    "Decidir se medidas, notas fiscais, valor das notas e data limite devem entrar no texto ou permanecer somente no PDF.",
    "Manter o PDF como anexo manual nesta primeira versao e validar o processo com os usuarios internos.",
    "Depois do teste, cadastrar a origem exata da extensao na allowlist somente se o navegador enviar uma origem estavel.",
]
for item in checklist:
    story.append(Paragraph(f"[ ] {item}", styles["BodySmall"]))
    story.append(Spacer(1, 1.5 * mm))

story.append(Spacer(1, 3 * mm))
note = Table([[p(
    "Conclusao: o MVP esta funcional para consulta, revisao e abertura do WhatsApp. "
    "O principal risco restante nao e tecnico, mas de cobertura de dados: varios campos do texto de e-mail "
    "nao fazem parte do contrato publico documentado da consulta de coleta.",
    "BodySmall",
)]], colWidths=[170 * mm])
note.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, -1), LIGHT_BLUE),
    ("BOX", (0, 0), (-1, -1), 0.8, BLUE),
    ("LEFTPADDING", (0, 0), (-1, -1), 9),
    ("RIGHTPADDING", (0, 0), (-1, -1), 9),
    ("TOPPADDING", (0, 0), (-1, -1), 8),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
]))
story.append(KeepTogether(note))

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
doc.build(story)
print(OUTPUT)
