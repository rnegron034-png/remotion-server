import os
import clip
import torch
import requests
from io import BytesIO
from PIL import Image
from flask import Flask, request, jsonify

# Reduce CPU + RAM usage
torch.set_num_threads(1)

app = Flask(__name__)

print("Loading CLIP model (RN50)...")
model, preprocess = clip.load("RN50")
model = model.half()   # use FP16 = 50% less RAM
model.eval()
print("CLIP loaded.")

def load_image(url):
    r = requests.get(url, timeout=10)
    r.raise_for_status()
    return Image.open(BytesIO(r.content)).convert("RGB")

@app.route("/rank", methods=["POST"])
def rank():
    try:
        data = request.get_json(force=True)

        scene = data["scene"]
        images = data["images"]

        text = clip.tokenize([scene])

        results = []

        with torch.no_grad():
            text_features = model.encode_text(text).half()

            for item in images:
                try:
                    img = load_image(item["thumb"])
                    img_tensor = preprocess(img).unsqueeze(0).half()
                    img_features = model.encode_image(img_tensor)

                    score = torch.cosine_similarity(img_features, text_features).item()

                    results.append({
                        "url": item["url"],
                        "score": round(score, 4)
                    })
                except Exception as e:
                    print("Image error:", e)

        results.sort(key=lambda x: x["score"], reverse=True)

        return jsonify(results[:3])

    except Exception as e:
        return jsonify({
            "error": str(e)
        }), 400

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    print("Starting server on port", port)
    app.run(host="0.0.0.0", port=port)
