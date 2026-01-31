import os
import torch
import requests
from io import BytesIO
from PIL import Image
from flask import Flask, request, jsonify
import open_clip

# Prevent CPU spikes that crash Railway
torch.set_num_threads(1)

app = Flask(__name__)

print("Loading OpenCLIP RN50...")
model, _, preprocess = open_clip.create_model_and_transforms("RN50", pretrained="openai")
tokenizer = open_clip.get_tokenizer("RN50")
model.eval()
print("CLIP loaded.")

# Safe image downloader (never blocks Railway)
def safe_download(url):
    try:
        r = requests.get(url, timeout=4, stream=True)
        r.raise_for_status()
        content = r.raw.read(1_000_000)   # max 1MB
        return Image.open(BytesIO(content)).convert("RGB")
    except Exception as e:
        print("Download error:", e)
        return None

@app.route("/rank", methods=["POST"])
def rank():
    try:
        data = request.get_json(force=True)

        scene = data["scene"]
        images = data["images"]

        # Tokenize text
        text_tokens = tokenizer([scene])

        results = []

        with torch.no_grad():
            # Force float32 (fixes mixed dtype crash)
            text_features = model.encode_text(text_tokens).float()

            for item in images:
                img = safe_download(item["thumb"])
                if not img:
                    continue

                try:
                    img_tensor = preprocess(img).unsqueeze(0)
                    img_features = model.encode_image(img_tensor).float()

                    score = torch.cosine_similarity(img_features, text_features).item()

                    results.append({
                        "url": item["url"],
                        "score": round(score, 4)
                    })
                except Exception as e:
                    print("Image processing error:", e)

        results.sort(key=lambda x: x["score"], reverse=True)
        return jsonify(results[:3])

    except Exception as e:
        print("Fatal error:", e)
        return jsonify({"error": str(e)}), 400

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    print("Starting server on port", port)
    app.run(host="0.0.0.0", port=port)
