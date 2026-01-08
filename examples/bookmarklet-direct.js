javascript:(function() {
  // Get current page info
  const url = encodeURIComponent(location.href);
  const title = encodeURIComponent(document.title);
  
  // Copy data to clipboard in JSON format
  const data = {
    type: "brainbox-capture",
    url: location.href,
    title: document.title,
    timestamp: new Date().toISOString()
  };
  
  // Copy as JSON to clipboard
  navigator.clipboard.writeText(JSON.stringify(data))
    .then(() => {
      // Create visual feedback overlay
      const overlay = document.createElement('div');
      overlay.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: #4caf50;
        color: white;
        padding: 12px 20px;
        border-radius: 8px;
        font-family: system-ui, -apple-system, sans-serif;
        z-index: 9999999;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        transition: opacity 0.5s ease-in-out;
      `;
      overlay.innerHTML = `
        <div style="display: flex; align-items: center; gap: 10px;">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
            <polyline points="22 4 12 14.01 9 11.01"></polyline>
          </svg>
          <div>
            <div style="font-weight: bold;">Copied to brainbox</div>
            <div style="font-size: 12px;">Paste in brainbox to capture</div>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      
      // Remove overlay after 3 seconds
      setTimeout(() => {
        overlay.style.opacity = '0';
        setTimeout(() => overlay.remove(), 500);
      }, 3000);
    })
    .catch(err => {
      alert("Failed to copy to clipboard: " + err);
    });
})();

