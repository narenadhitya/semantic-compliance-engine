import os
from bs4 import BeautifulSoup
from pypdf import PdfReader
from docx import Document as DocxReader
from pptx import Presentation as PptxReader
from odf import text,teletype
from odf.opendocument import load

def extract_text_factory(file_path: str) -> str:
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"Target file missing: {file_path}")
    
    _, ext = os.path.splitext(file_path)
    ext = ext.lower()

    # 1. Plain Text & Markdown (.txt, .md)
    if ext in ['.txt', '.md']:
        with open(file_path,'r',encoding='utf-8') as f:
            return f.read()
    
    # 2. Modern Word Documents (.docx)
    elif ext == '.docx':
        doc = DocxReader(file_path)
        body_elements = []
        for para in doc.paragraphs:
            if para.text.strip():
                body_elements.append(para.text)

            if "w:drawing" in para._p.xml:
                # Always emit as a SEPARATE element so the alias always lands
                # on its own line in the extracted text -- critical for difflib
                # to detect image deletions as clean 'deleted' opcodes rather
                # than absorbing them into a surrounding 'modified' hunk.
                body_elements.append("[IMAGE ALIAS: Embedde Word Diagram/Graphic Layout]")
        return "\n".join(body_elements)
    
    # 3. PowerPoint Presentations (.pptx)
    elif ext == '.pptx':
        prs = PptxReader(file_path)
        slide_text = []
        for i, slide in enumerate(prs.slides, start =1):
            for shape in slide.shapes:
                if hasattr(shape,"text") and shape.text.strip():
                    slide_text.append(shape.text.strip())
                # 13 corresponds to the MSO_SHAPE_TYPE.PICTURE enum
                elif shape.shape_type == 13:
                    slide_text.append(f"\n[IMAGE ALIAS: Presentation Visual Graphic on Slide {i}]\n")
        return "\n".join(slide_text)
    
    # 4. Portable Document Format (.pdf)
    elif ext == '.pdf':
        reader = PdfReader(file_path)
        extracted_pages = []
        for page in reader.pages:
            page_text = page.extract_text()
            if page_text:
                extracted_pages.append(page_text)
            
            if page.images:
                extracted_pages.append("\n[IMAGE ALIAS: Embedded PDF Visual Asset/Scan]\n")
        return "\n".join(extracted_pages)
    
    # 5. HTML / Wiki Portals (.html, .htm)
    elif ext in ['.html', '.htm']:
        with open(file_path, 'r', encoding='utf-8') as f:
            soup = BeautifulSoup(f.read(), 'html.parser')
            # Extract and swap images with their semantic alt-text
            for img in soup.find_all('img'):
                alt_text = img.get('alt', '').strip()
                semantic_token = f" [IMAGE ALT-TEXT: {alt_text}] " if alt_text else " [IMAGE ALIAS: Unlabeled Web Graphic] "
                img.replace_with(semantic_token)
            
            # Strip formatting and return pure text
            for script in soup(["script", "style"]):
                script.decompose()
            return "\n".join([line.strip() for line in soup.get_text().splitlines() if line.strip()])

    # 6. OpenDocument Text (.odt)
    elif ext == '.odt':
        odt_doc = load(file_path)
        paragraphs = odt_doc.getElementsByType(text.P)
        return "\n".join([teletype.extractText(p) for p in paragraphs if teletype.extractText(p).strip()])
    
    else:
        raise ValueError(f"Unsupported file format:{ext}")
