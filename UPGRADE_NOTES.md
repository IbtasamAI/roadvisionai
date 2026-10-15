# RoadVision AI 2026 upgrade

- Camera discovery with permission prompt, hot-plug refresh and persisted selected camera. Browsers expose only cameras permitted by the OS/browser; some phones combine multiple lenses into one logical camera.
- Assisted distance/zone uses camera height, downward tilt, approximate vertical FOV and flat-ground perspective. This is NOT learned monocular depth, lidar, or calibrated distance. Measurements require physical verification; do not use for enforcement.
- Original manual zone and built-in 11 × 40 m zone preserved.
- Six themes: Asphalt, Daylight, Midnight, Aurora, Graphite and Neon.
- Refreshed SVG and PWA icons; reduced-motion support.
- Existing bundled TensorFlow.js + COCO-SSD kept offline. COCO-SSD is general object detection, not a dedicated vehicle tracker or distance estimator. Validate its version, license, and detection precision against real footage before upgrading model weights.
- Suggested next upgrades: calibrated reference marker wizard, optional WebGPU/ONNX runtime with supported vehicle model, per-device camera intrinsics, tracking benchmark, device thermal throttling, and regression tests on iOS Safari/Android Chrome.
- Netlify: upload ZIP contents as deploy directory. HTTPS is required for camera access.

2026 branding revision: custom camera/radar SVG logo, matching 192px/512px install icons, and refreshed names for six selectable themes.

## 2026.2 Visual and performance refinements
- Updated glass-cockpit header, modern typography, cards, camera stage and theme selector.
- Reduced unnecessary overlay rendering while the tab is hidden.
- Preserved offline model, existing calibration controls and camera functionality.
- Browser-specific camera selection, AI throughput and speed accuracy require physical-device validation.
- Camera distance is an estimate, not a validated depth measurement.
