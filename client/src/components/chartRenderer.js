export class ChartRenderer {
  constructor(canvas, dimensions, config) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to get canvas context");
    this.ctx = ctx;
    this.dimensions = dimensions;
    this.config = config;
    this._setupCanvas(canvas);
  }

  _setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = this.dimensions.width * dpr;
    canvas.height = this.dimensions.height * dpr;
    canvas.style.width = `${this.dimensions.width}px`;
    canvas.style.height = `${this.dimensions.height}px`;
    this.ctx.scale(dpr, dpr);
  }

  _chartArea() {
    const { width, height, padding } = this.dimensions;
    return {
      x: padding.left,
      y: padding.top,
      width: width - padding.left - padding.right,
      height: height - padding.top - padding.bottom,
    };
  }

  clear() {
    this.ctx.clearRect(0, 0, this.dimensions.width, this.dimensions.height);
  }

  drawBackground() {
    const area = this._chartArea();
    const gradient = this.ctx.createLinearGradient(
      area.x, area.y, area.x, area.y + area.height
    );
    gradient.addColorStop(0, "rgba(0, 0, 0, 0.02)");
    gradient.addColorStop(1, "rgba(0, 0, 0, 0.05)");
    this.ctx.fillStyle = gradient;
    this.ctx.fillRect(area.x, area.y, area.width, area.height);
  }

  drawAxes() {
    const area = this._chartArea();
    this.ctx.strokeStyle = this.config.colors.axis;
    this.ctx.lineWidth = 1;

    this.ctx.beginPath();
    this.ctx.moveTo(area.x, area.y + area.height);
    this.ctx.lineTo(area.x + area.width, area.y + area.height);
    this.ctx.stroke();

    this.ctx.beginPath();
    this.ctx.moveTo(area.x, area.y);
    this.ctx.lineTo(area.x, area.y + area.height);
    this.ctx.stroke();
  }

  drawTimeLabels(timeRange) {
    const area = this._chartArea();
    this.ctx.fillStyle = this.config.colors.text;
    this.ctx.font = "10px 'JetBrains Mono', monospace";
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "top";

    const labelsMap = {
      "1m": ["60s", "45s", "30s", "15s", "now"],
      "3m": ["3m", "2m", "1m", "now"],
      "5m": ["5m", "4m", "3m", "2m", "1m", "now"],
      "10m": ["10m", "8m", "6m", "4m", "2m", "now"],
    };

    const labels = labelsMap[timeRange] || [];
    const spacing = area.width / (labels.length - 1);

    labels.forEach((label, i) => {
      this.ctx.fillText(label, area.x + i * spacing, area.y + area.height + 4);
    });
  }

  drawBars(dataPoints, maxValue, getSessionColor) {
    const area = this._chartArea();
    const barCount = this.config.maxDataPoints;
    const totalBarWidth = area.width / barCount;
    const barWidth = Math.max(this.config.barWidth, 2);

    dataPoints.forEach((point, index) => {
      if (point.count === 0) return;

      const x = area.x + index * totalBarWidth + (totalBarWidth - barWidth) / 2;
      const barHeight = (point.count / maxValue) * area.height;
      const y = area.y + area.height - barHeight;

      // Determine bar color from dominant session
      let barColor = this.config.colors.primary;
      if (getSessionColor && point.sessions) {
        const entries = Object.entries(point.sessions);
        if (entries.length > 0) {
          const dominant = entries.sort((a, b) => b[1] - a[1])[0][0];
          barColor = getSessionColor(dominant);
        }
      }

      // Glow
      this._drawGlow(x, y, barWidth, barHeight, point.count / maxValue, barColor);

      // Bar with rounded top
      this.ctx.save();
      this.ctx.beginPath();
      const r = Math.min(2, barWidth / 2);
      this.ctx.moveTo(x, y + r);
      this.ctx.arcTo(x, y, x + barWidth, y, r);
      this.ctx.arcTo(x + barWidth, y, x + barWidth, y + r, r);
      this.ctx.lineTo(x + barWidth, y + barHeight);
      this.ctx.lineTo(x, y + barHeight);
      this.ctx.closePath();

      const gradient = this.ctx.createLinearGradient(x, y, x, y + barHeight);
      gradient.addColorStop(0, this._rgba(barColor, 0.9));
      gradient.addColorStop(0.5, barColor);
      gradient.addColorStop(1, this._rgba(barColor, 0.7));
      this.ctx.fillStyle = gradient;
      this.ctx.fill();
      this.ctx.restore();
    });
  }

  _drawGlow(x, y, width, height, intensity, color) {
    const glowRadius = 10 + intensity * 20;
    const cx = x + width / 2;
    const cy = y + height / 2;
    const gradient = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, glowRadius);
    gradient.addColorStop(0, this._rgba(color, 0.3 * intensity));
    gradient.addColorStop(1, "transparent");
    this.ctx.fillStyle = gradient;
    this.ctx.fillRect(cx - glowRadius, cy - glowRadius, glowRadius * 2, glowRadius * 2);
  }

  drawPulseEffect(x, y, radius, opacity) {
    const color = this.config.colors.primary;
    const gradient = this.ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, this._rgba(color, opacity));
    gradient.addColorStop(0.5, this._rgba(color, opacity * 0.5));
    gradient.addColorStop(1, "transparent");
    this.ctx.fillStyle = gradient;
    this.ctx.beginPath();
    this.ctx.arc(x, y, radius, 0, Math.PI * 2);
    this.ctx.fill();
  }

  resize(dimensions) {
    this.dimensions = dimensions;
    this._setupCanvas(this.ctx.canvas);
  }

  _rgba(color, opacity) {
    if (color.startsWith("#")) {
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${opacity})`;
    }
    return color;
  }
}
