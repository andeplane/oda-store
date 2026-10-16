/**
 * Reusable 3D product models for the Oda catalog: 35 procedural packaging meshes, a single
 * atlas-textured material, and an instanced layer. Depends only on three.js.
 *
 *   const mat = productMaterial(atlasTexture);
 *   const layer = new ProductLayer(mat);
 *   layer.begin(); layer.add({ shape, rect, color }, matrixWithWHDscale); layer.end();
 */
export * from './geometry';
export * from './material';
export * from './layer';
