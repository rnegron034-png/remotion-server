import React from 'react';
import { Series, Video, Audio, useVideoConfig, staticFile } from 'remotion';

export const VideoSequence = ({ scenes, audio }) => {
  const { fps } = useVideoConfig();

  // CRITICAL: Handle props undefined case
  // Why: Remotion may call component before props are loaded
  if (!scenes || !Array.isArray(scenes)) {
    return null;
  }

  return (
    <>
      <Series>
        {scenes.map((scene, index) => (
          <Series.Sequence key={index} durationInFrames={150}>
            <Video src={scene.src} />
          </Series.Sequence>
        ))}
      </Series>

      {audio && audio.src && (
        <Audio src={audio.src} />
      )}
    </>
  );
};
```

**Why:**
- **`if (!scenes)` guard**: Prevents `props is not defined` errors
- **`Series`**: Plays videos sequentially
- **Hardcoded `durationInFrames`**: Simplifies logic (adjust per scene if needed)
- **Optional audio**: Only rendered if `audio.src` exists

---

## **Deployment**

1. **Push to GitHub**
2. **Connect Railway to repo**
3. **Railway auto-detects Dockerfile**
4. **Set environment variables** (if needed):
```
   PORT=3000
```

---

## **Testing from n8n**

### **n8n HTTP Request Node Config:**

**Request 1: Start Render**
```
Method: POST
URL: https://your-railway-app.railway.app/remotion-render
Body:
{
  "scenes": [
    { "src": "https://cdn.example.com/video1.mp4" },
    { "src": "https://cdn.example.com/video2.mp4" }
  ],
  "audio": {
    "src": "https://example.com/audio.mp3"
  }
}
```

**Request 2: Poll Status**
```
Method: GET
URL: https://your-railway-app.railway.app/status/{{$json.jobId}}
```

**Request 3: Download**
```
Method: GET
URL: https://your-railway-app.railway.app/download/{{$json.jobId}}
