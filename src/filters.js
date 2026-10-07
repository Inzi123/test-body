// Filtro "One Euro" (Casiez et al., 2012): suaviza el temblor cuando hay poco
// movimiento y reduce el retraso cuando el movimiento es rápido.

function smoothingFactor(cutoff, dt) {
  const r = 2 * Math.PI * cutoff * dt;
  return r / (r + 1);
}

export class OneEuroFilter {
  constructor(minCutoff = 1.5, beta = 1.5, dCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() {
    this.x = null;
    this.dx = 0;
  }

  filter(value, dt) {
    if (this.x === null || !(dt > 0)) {
      this.x = value;
      this.dx = 0;
      return value;
    }
    const dx = (value - this.x) / dt;
    this.dx += smoothingFactor(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += smoothingFactor(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

/** Filtra un conjunto de N puntos 3D (los landmarks del cuerpo). */
export class LandmarkFilter {
  constructor(count) {
    this.filters = Array.from({ length: count * 3 }, () => new OneEuroFilter());
    this.minCutoff = 1.5;
  }

  /** `smoothing` en [0, 1]: 0 = respuesta inmediata, 1 = muy suave. */
  setSmoothing(smoothing) {
    this.minCutoff = 6 * Math.pow(0.04, smoothing); // 6 Hz … 0.24 Hz
  }

  reset() {
    for (const f of this.filters) f.reset();
  }

  /**
   * Filtra en el lugar un array de THREE.Vector3. Con `confidence` (0..1 por
   * punto), los puntos poco confiables (p. ej. tapados) se suavizan más.
   */
  apply(points, dt, confidence) {
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const c = confidence ? confidence[i] : 1;
      const cutoff = this.minCutoff * (c >= 0.5 ? 1 : 0.25 + c);
      const fx = this.filters[i * 3];
      const fy = this.filters[i * 3 + 1];
      const fz = this.filters[i * 3 + 2];
      fx.minCutoff = fy.minCutoff = fz.minCutoff = cutoff;
      p.x = fx.filter(p.x, dt);
      p.y = fy.filter(p.y, dt);
      p.z = fz.filter(p.z, dt);
    }
  }
}
