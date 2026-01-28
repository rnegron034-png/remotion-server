import { AbsoluteFill, Video, useCurrentFrame, useVideoConfig } from 'remotion';

export const VideoComposition = ({ scene = {}, subtitles = [] }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  
  // ✅ DEFENSIVE: Always validate props
  const videoSrc = scene?.src || scene?.url || '';
  const safeSubtitles = Array.isArray(subtitles) ? subtitles : [];
  
  // Calculate current time
  const currentTime = frame / fps;
  
  // Find active subtitle
  const activeSubtitle = safeSubtitles.find(
    (sub) => 
      sub?.start !== undefined &&
      sub?.end !== undefined &&
      sub.start <= currentTime && 
      currentTime <= sub.end
  );

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {/* Video layer */}
      {videoSrc && (
        <Video
          src={videoSrc}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
          startFrom={0}
          // ✅ Prevent crashes on load error
          onError={(e) => {
            console.error('Video load error:', videoSrc, e);
          }}
        />
      )}
      
      {/* Burned-in subtitles */}
      {activeSubtitle?.text && (
        <AbsoluteFill
          style={{
            justifyContent: 'flex-end',
            alignItems: 'center',
            paddingBottom: 120,
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              backgroundColor: 'rgba(0, 0, 0, 0.85)',
              color: '#FFFFFF',
              fontSize: 52,
              fontWeight: 'bold',
              fontFamily: 'Arial, sans-serif',
              padding: '20px 40px',
              borderRadius: 12,
              maxWidth: '90%',
              textAlign: 'center',
              lineHeight: 1.4,
              boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
              // ✅ CTR-optimized styling
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}
          >
            {activeSubtitle.text}
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
