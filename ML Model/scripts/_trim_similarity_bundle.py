import sys
sys.path.insert(0, r'C:\Users\ASUS\OneDrive\Desktop\frontedn\mobile-recommendation-system\ML Model')
import joblib, numpy as np
src, dst = sys.argv[1], sys.argv[2]
bundle = joblib.load(src)
df = bundle['df']; sim = bundle['similarity_matrix']
fw = bundle.get('feature_weights') or {}
joblib.dump({
    'df': df,
    'similarity_matrix': np.asarray(sim, dtype=np.float64),
    'feature_weights': dict(fw),
    'n_phones': int(len(df)),
    'similarity_dim': int(np.asarray(sim).shape[0]),
}, dst)
print(f'trimmed: n_phones={len(df)}, matrix={sim.shape}')
