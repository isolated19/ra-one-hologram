import * as THREE from 'three';
import { HolographicMaterial } from '../materials/HolographicMaterial.js';
import { buildHoodMesh } from './HoodGeometry.js';
import { buildFaceMesh } from './FaceParticles.js';

/**
 * Semi-transparent hologram surfaces under the particles: a faint veil on the
 * hood and a fresnel-contoured face. The particles carry most of the structure.
 */
export class HologramFigure {
  constructor(uniforms) {
    this.group = new THREE.Group();

    this.hoodMaterial = new HolographicMaterial(uniforms, {
      cutFace: true,
      fresnelAmount: 0.5,
      bodyAmount: 0.03,
      hologramOpacity: 0.4,
    });
    this.faceMaterial = new HolographicMaterial(uniforms, {
      concealOutsideOpening: true,
      fresnelAmount: 0.9,
      bodyAmount: 0.07,
      scanlineSize: 4.5,
      hologramOpacity: 0.6,
    });

    this.hood = new THREE.Mesh(buildHoodMesh(), this.hoodMaterial);
    this.face = new THREE.Mesh(buildFaceMesh(), this.faceMaterial);
    this.hood.renderOrder = 1;
    this.face.renderOrder = 2;
    this.group.add(this.hood, this.face);
  }

  dispose() {
    this.hood.geometry.dispose();
    this.face.geometry.dispose();
    this.hoodMaterial.dispose();
    this.faceMaterial.dispose();
  }
}
