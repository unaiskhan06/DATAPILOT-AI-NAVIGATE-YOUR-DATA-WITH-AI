(function () {
  "use strict";

  const canvas = document.getElementById("glassTilesBg");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let width = 0;
  let height = 0;
  let dpr = 1;
  let frameId = 0;
  let visible = true;
  let lastTime = 0;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function roundRect(x, y, w, h, radius) {
    const r = Math.min(radius, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function hash(row, col) {
    const value = Math.sin(row * 91.7 + col * 47.3 + 17.1) * 43758.5453;
    return value - Math.floor(value);
  }

  function draw(time) {
    ctx.clearRect(0, 0, width, height);

    const tileSize = width < 640 ? 52 : 72;
    const gap = width < 640 ? 4 : 6;
    const columns = Math.ceil(width / (tileSize + gap)) + 1;
    const rows = Math.ceil(height / (tileSize + gap)) + 1;
    const shimmer = reduceMotion.matches ? 0.45 : (Math.sin(time * 0.0007) + 1) / 2;

    for (let row = -1; row < rows; row++) {
      for (let col = -1; col < columns; col++) {
        const noise = hash(row, col);
        const x = col * (tileSize + gap) - 28;
        const y = row * (tileSize + gap) - 28;

        ctx.save();
        roundRect(x, y, tileSize, tileSize, 13);

        const gradient = ctx.createLinearGradient(x, y, x + tileSize, y + tileSize);
        if ((row + col) % 3 === 0) {
          gradient.addColorStop(0, `rgba(59, 125, 246, ${0.10 + noise * 0.08})`);
          gradient.addColorStop(1, `rgba(106, 61, 246, ${0.16 + noise * 0.08})`);
        } else if ((row + col) % 3 === 1) {
          gradient.addColorStop(0, `rgba(255, 255, 255, ${0.28 + noise * 0.12})`);
          gradient.addColorStop(1, `rgba(106, 61, 246, ${0.08 + noise * 0.08})`);
        } else {
          gradient.addColorStop(0, `rgba(59, 125, 246, ${0.05 + noise * 0.07})`);
          gradient.addColorStop(1, `rgba(255, 255, 255, ${0.20 + noise * 0.12})`);
        }

        ctx.fillStyle = gradient;
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.42)";
        ctx.lineWidth = 1;
        ctx.stroke();

        const shineX = x - tileSize + shimmer * (tileSize * 3);
        const shine = ctx.createLinearGradient(shineX, y, shineX + tileSize * 0.45, y + tileSize);
        shine.addColorStop(0, "rgba(255, 255, 255, 0)");
        shine.addColorStop(0.5, "rgba(255, 255, 255, 0.22)");
        shine.addColorStop(1, "rgba(255, 255, 255, 0)");
        ctx.clip();
        ctx.fillStyle = shine;
        ctx.fillRect(x, y, tileSize, tileSize);
        ctx.restore();
      }
    }
  }

  function animate(time) {
    frameId = 0;
    lastTime = time;
    if (visible) draw(time);
    if (!reduceMotion.matches && visible) {
      frameId = requestAnimationFrame(animate);
    }
  }

  function start() {
    if (reduceMotion.matches) {
      draw(lastTime);
    } else if (!frameId) {
      frameId = requestAnimationFrame(animate);
    }
  }

  function stop() {
    if (frameId) cancelAnimationFrame(frameId);
    frameId = 0;
  }

  function init() {
    resize();
    draw(0);
    start();
  }

  if ("ResizeObserver" in window) {
    new ResizeObserver(() => {
      resize();
      draw(lastTime);
    }).observe(canvas);
  } else {
    window.addEventListener("resize", () => {
      resize();
      draw(lastTime);
    });
  }

  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      visible = entries[0].isIntersecting;
      if (visible) start();
      else stop();
    }).observe(canvas);
  }

  reduceMotion.addEventListener("change", () => {
    stop();
    init();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
