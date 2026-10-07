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
  }

  /** `smoothing` en [0, 1]: 0 = respuesta inmediata, 1 = muy suave. */
  setSmoothing(smoothing) {
    const minCutoff = 6 * Math.pow(0.04, smoothing); // 6 Hz … 0.24 Hz
    for (const f of this.filters) f.minCutoff = minCutoff;
  }

  reset() {
    for (const f of this.filters) f.reset();
  }

  /** Filtra en el lugar un array de THREE.Vector3. */
  apply(points, dt) {
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      p.x = this.filters[i * 3].filter(p.x, dt);
      p.y = this.filters[i * 3 + 1].filter(p.y, dt);
      p.z = this.filters[i * 3 + 2].filter(p.z, dt);
    }
  }
}
