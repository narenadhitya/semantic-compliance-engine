import base64
import hashlib
import requests
from database import get_connection

OLLAMA_URL = "http://localhost:11434/api/generate"

def get_image_caption(image_bytes: bytes, document_name: str) -> str:
    """
    Given raw image bytes and document_name, returns a descriptive caption.
    Uses a deterministic SHA-256 hash to cache the generated caption in PostgreSQL.
    Tracks which documents use the image via the document_names array.
    """
    if not image_bytes:
        return "[IMAGE ALIAS: Empty or unreadable graphic]"
        
    image_hash = hashlib.sha256(image_bytes).hexdigest()
    
    conn = get_connection()
    cur = conn.cursor()
    try:
        # Check cache
        cur.execute("SELECT caption FROM image_captions_cache WHERE image_hash = %s;", (image_hash,))
        result = cur.fetchone()
        if result:
            cur.execute("""
                UPDATE image_captions_cache
                SET document_names = array_append(document_names, %s)
                WHERE image_hash = %s AND NOT (%s = ANY(document_names));
            """, (document_name, image_hash, document_name))
            conn.commit()
            return result[0]

            
        # If not cached, send to Ollama
        encoded_image = base64.b64encode(image_bytes).decode('utf-8')
        
        payload = {
            "model": "llava-phi3",
            "prompt": (
                "Describe the contents of this image."
                "Do not use introductory filler or conversational phrases."
                "Provide a highly dense, summary in 2 to 3 sentences. "
            ),
            "images": [encoded_image],
            "stream": False
        }
        
        response = requests.post(OLLAMA_URL, json=payload, timeout=120)
        response.raise_for_status()
        
        caption_text = response.json().get("response", "").strip()
        if not caption_text:
            caption_text = "Embedded visual asset (No details extracted)"
        
        # Format it consistently with existing aliases for structural diffing
        final_caption = f"[IMAGE ALIAS: {caption_text}]"
        
        # Save to cache
        cur.execute(
            "INSERT INTO image_captions_cache (image_hash, caption, document_names) VALUES (%s, %s, ARRAY[%s]::TEXT[]);",
            (image_hash, final_caption, document_name)
        )
        conn.commit()
        
        return final_caption
        
    except Exception as e:
        print(f"[VISION ERROR] Failed to caption image: {e}")
        return "[IMAGE ALIAS: Embedded visual asset]"
    finally:
        cur.close()
        conn.close()
