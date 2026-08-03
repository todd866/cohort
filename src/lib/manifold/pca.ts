/**
 * PCA (Principal Component Analysis) Module
 *
 * Economy SVD approach for tall-skinny matrices (n items << d dimensions).
 * Instead of computing the d×d covariance matrix, we compute the n×n
 * "inner" covariance C = X X^T / (n-1) and recover the d-dimensional
 * principal components from its eigenvectors.
 *
 * This makes PCA on 200 items × 1024 dims run in seconds, not minutes.
 */

export interface PCAResult {
  /** k × d principal components (row vectors, unit length) */
  basis: number[][];
  /** d-dimensional mean vector (for centering) */
  mean: number[];
  /** k variance ratios (each PC's share of total variance) */
  explainedVariance: number[];
  /** Sum of explained variance ratios */
  totalVarianceExplained: number;
}

/**
 * Compute PCA on a set of d-dimensional vectors.
 *
 * Uses the economy SVD trick: when n << d, compute the n×n
 * covariance matrix instead of d×d, eigendecompose it, then
 * recover the d-dimensional principal components.
 *
 * @param vectors - n vectors of d dimensions
 * @param k - number of principal components desired
 * @returns PCAResult with basis, mean, and variance info
 */
export function computePCA(vectors: number[][], k: number): PCAResult {
  const n = vectors.length;
  if (n === 0) {
    return { basis: [], mean: [], explainedVariance: [], totalVarianceExplained: 0 };
  }

  const d = vectors[0].length;

  // Step 1: Compute mean
  const mean = new Array<number>(d).fill(0);
  for (const v of vectors) {
    for (let j = 0; j < d; j++) {
      mean[j] += v[j];
    }
  }
  for (let j = 0; j < d; j++) {
    mean[j] /= n;
  }

  // Step 2: Center the data (X[i] = vectors[i] - mean)
  const X: number[][] = vectors.map((v) => v.map((val, j) => val - mean[j]));

  // Can't extract PCs from fewer than 2 vectors
  if (n < 2) {
    return { basis: [], mean, explainedVariance: [], totalVarianceExplained: 0 };
  }

  // Step 3: Compute small n×n covariance-like matrix C = X X^T / (n-1)
  // C[i][j] = dot(X[i], X[j]) / (n-1)
  const C: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let dotProd = 0;
      for (let l = 0; l < d; l++) {
        dotProd += X[i][l] * X[j][l];
      }
      dotProd /= n - 1;
      C[i][j] = dotProd;
      C[j][i] = dotProd;
    }
  }

  // Step 4: Eigendecompose C using Jacobi iteration
  const { eigenvalues, eigenvectors } = symmetricEigen(C);

  // Step 5: Recover d-dimensional PCs from eigenvectors of C
  // pc_j = X^T * v_j / sqrt(lambda_j * (n-1))
  // where v_j is the j-th eigenvector of C and lambda_j its eigenvalue
  const totalVariance = eigenvalues.reduce((sum, ev) => sum + Math.max(0, ev), 0);

  if (totalVariance < 1e-15) {
    return { basis: [], mean, explainedVariance: [], totalVarianceExplained: 0 };
  }

  // Clamp k to number of non-trivial eigenvectors
  // Use relative threshold: eigenvalue must be > 1e-6 * largest eigenvalue
  const relThreshold = Math.max(1e-10, eigenvalues[0] * 1e-6);
  const maxK = Math.min(k, eigenvalues.filter((ev) => ev > relThreshold).length);

  const basis: number[][] = [];
  const explainedVariance: number[] = [];

  for (let j = 0; j < maxK; j++) {
    const lambda = eigenvalues[j];
    if (lambda < relThreshold) break;

    const v = eigenvectors[j]; // n-dimensional eigenvector

    // Recover d-dimensional PC: pc = X^T * v / sqrt(lambda * (n-1))
    const scale = Math.sqrt(lambda * (n - 1));
    const pc = new Array<number>(d).fill(0);
    for (let i = 0; i < n; i++) {
      for (let l = 0; l < d; l++) {
        pc[l] += X[i][l] * v[i];
      }
    }

    // Normalize to unit length
    let pcNorm = 0;
    for (let l = 0; l < d; l++) {
      pc[l] /= scale;
      pcNorm += pc[l] * pc[l];
    }
    pcNorm = Math.sqrt(pcNorm);

    if (pcNorm < 1e-10) continue;

    for (let l = 0; l < d; l++) {
      pc[l] /= pcNorm;
    }

    basis.push(pc);
    explainedVariance.push(lambda / totalVariance);
  }

  const totalExplained = explainedVariance.reduce((sum, v) => sum + v, 0);

  return { basis, mean, explainedVariance, totalVarianceExplained: totalExplained };
}

/**
 * Project a single d-dimensional vector into the local k-dimensional space.
 *
 * @param v - d-dimensional vector
 * @param mean - d-dimensional mean (for centering)
 * @param basis - k × d principal components
 * @returns k-dimensional local coordinates
 */
export function projectToLocal(v: number[], mean: number[], basis: number[][]): number[] {
  const k = basis.length;
  const d = v.length;
  const result = new Array<number>(k);

  for (let i = 0; i < k; i++) {
    let dot = 0;
    for (let j = 0; j < d; j++) {
      dot += (v[j] - mean[j]) * basis[i][j];
    }
    result[i] = dot;
  }

  return result;
}

/**
 * Project multiple vectors into local space (same as individual projections).
 */
export function projectBatchToLocal(
  vs: number[][],
  mean: number[],
  basis: number[][]
): number[][] {
  return vs.map((v) => projectToLocal(v, mean, basis));
}

// =============================================================================
// Symmetric eigendecomposition via Jacobi iteration
// =============================================================================

interface EigenResult {
  eigenvalues: number[];
  eigenvectors: number[][];
}

/**
 * Jacobi eigendecomposition for symmetric matrices.
 * Returns eigenvalues and eigenvectors sorted by eigenvalue descending.
 *
 * Uses cyclic Jacobi sweeps: each sweep rotates ALL upper-triangle pairs
 * (p,q), then checks convergence. Converges quadratically in ~5-15 sweeps.
 * Cost: O(n^2) rotations per sweep × O(n) per rotation = O(n^3) per sweep.
 *
 * For n=200: ~15 sweeps × 20k pairs × 200 ops ≈ 60M ops (vs billions for classic).
 */
function symmetricEigen(A: number[][]): EigenResult {
  const n = A.length;
  if (n === 0) return { eigenvalues: [], eigenvectors: [] };
  if (n === 1) return { eigenvalues: [A[0][0]], eigenvectors: [[1]] };

  // Work on a copy
  const S: number[][] = A.map((row) => [...row]);

  // Accumulate rotations in V (starts as identity)
  const V: number[][] = Array.from({ length: n }, (_, i) => {
    const row = new Array(n).fill(0);
    row[i] = 1;
    return row;
  });

  const MAX_SWEEPS = 50;
  const TOL = 1e-12;

  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    // Check convergence: off-diagonal Frobenius norm
    let offNorm = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        offNorm += S[i][j] * S[i][j];
      }
    }
    if (Math.sqrt(2 * offNorm) < TOL) break;

    // Sweep through ALL upper-triangle pairs
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(S[p][q]) < TOL * 0.01) continue; // skip near-zero

        // Compute Jacobi rotation angle
        const theta =
          Math.abs(S[p][p] - S[q][q]) < TOL
            ? Math.PI / 4
            : 0.5 * Math.atan2(2 * S[p][q], S[p][p] - S[q][q]);

        const c = Math.cos(theta);
        const s = Math.sin(theta);

        // Apply rotation to S: S' = G^T S G
        const newSp = new Array(n);
        const newSq = new Array(n);

        for (let i = 0; i < n; i++) {
          newSp[i] = c * S[p][i] + s * S[q][i];
          newSq[i] = -s * S[p][i] + c * S[q][i];
        }

        for (let i = 0; i < n; i++) {
          S[p][i] = newSp[i];
          S[q][i] = newSq[i];
        }

        for (let i = 0; i < n; i++) {
          S[i][p] = S[p][i];
          S[i][q] = S[q][i];
        }

        // Fix the 2×2 block
        S[p][p] = c * newSp[p] + s * newSp[q];
        S[q][q] = -s * newSq[p] + c * newSq[q];
        S[p][q] = 0;
        S[q][p] = 0;

        // Accumulate rotation in V
        for (let i = 0; i < n; i++) {
          const vip = V[i][p];
          const viq = V[i][q];
          V[i][p] = c * vip + s * viq;
          V[i][q] = -s * vip + c * viq;
        }
      }
    }
  }

  // Extract eigenvalues from diagonal of S
  const eigenvalues = new Array(n);
  for (let i = 0; i < n; i++) {
    eigenvalues[i] = S[i][i];
  }

  // Sort by eigenvalue descending
  const indices = Array.from({ length: n }, (_, i) => i);
  indices.sort((a, b) => eigenvalues[b] - eigenvalues[a]);

  const sortedEigenvalues = indices.map((i) => eigenvalues[i]);
  const sortedEigenvectors = indices.map((idx) => {
    // Column idx of V
    const vec = new Array(n);
    for (let i = 0; i < n; i++) {
      vec[i] = V[i][idx];
    }
    return vec;
  });

  return { eigenvalues: sortedEigenvalues, eigenvectors: sortedEigenvectors };
}
