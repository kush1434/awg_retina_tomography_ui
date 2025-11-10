# awg_retina_tomography_ui
UI elements for GeneLab AWG Retina Tomography


# Retina Tomography Viewer

A **Three.js web viewer** for visualizing 3D STL models. This viewer loads and displays `.stl` files directly from Hugging Face and provides a sidebar to toggle layers.

---

## Requirements

You only need a modern web browser that supports ES Modules (e.g. Chrome, Edge, Firefox, Safari).

---

## Files

awg_retina_tomography_ui/  
│  
├── displayer.html   # Main 3D viewer script  
└── README.md        # This file

---

## How to Run

### Option 1 — Open directly

1. Download or clone the repository.  
2. Open `displayer.html` in your browser (double-click it).

Some browsers block `import` statements for local files. If you see CORS or import errors, use Option 2 below.

---

### Option 2 — Run a local web server

You can run a simple local server from the project folder.

**Using Python 3:**  
python3 -m http.server 8000  

Then visit:  
http://localhost:8000/displayer.html  

---

## Credits

- [Three.js](https://threejs.org/)
- [STLLoader](https://threejs.org/docs/#examples/en/loaders/STLLoader)
- [OrbitControls](https://threejs.org/docs/#examples/en/controls/OrbitControls)
- STL datasets hosted on [Hugging Face](https://huggingface.co/datasets)

---

## 📜 License

MIT License © 2025