import clip
import torch
from PIL import Image
import requests
from io import BytesIO
from flask import Flask, request, jsonify

app = Flask(__name__)

model, preprocess = clip.load("ViT-B/32")

def get_image(url):
    r = requests.get(url, timeout=10)
    return Image.open(BytesIO(r.content)).convert("RGB")

@app.route("/rank", methods=["POST"])
def rank():
    data = request.json
    scene = data["scene"]
    images = data["images"]

    text = clip.tokenize([scene])

    scores = []

    with torch.no_grad():
        text_features = model.encode_text(text)

        for img in images:
            try:
                image = preprocess(get_image(img["thumb"])).unsqueeze(0)
                image_features = model.encode_image(image)
                score = torch.cosine_similarity(image_features, text_features).item()
                scores.append({
                    "url": img["url"],
                    "score": score
                })
            except:
                pass

    scores.sort(key=lambda x: x["score"], reverse=True)

    return jsonify(scores[:3])
