import { useEffect } from 'react';

export function useBrowserMeta(botInfo, currentTrack) {
  useEffect(() => {
    // Update document title
    if (botInfo?.name) {
      if (currentTrack?.title) {
        document.title = `${botInfo.name} - ${currentTrack.title}`;
      } else {
        document.title = botInfo.name;
      }
    }
  }, [botInfo?.name, currentTrack?.title]);

  useEffect(() => {
    // Update favicon with circular avatar
    if (botInfo?.avatarUrl) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const size = 32;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        // Draw circular clip
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();

        // Draw image
        ctx.drawImage(img, 0, 0, size, size);

        // Set favicon
        let link = document.querySelector("link[rel~='icon']");
        if (!link) {
          link = document.createElement('link');
          link.rel = 'icon';
          document.head.appendChild(link);
        }
        link.href = canvas.toDataURL('image/png');
      };
      img.src = botInfo.avatarUrl;
    }
  }, [botInfo?.avatarUrl]);
}
