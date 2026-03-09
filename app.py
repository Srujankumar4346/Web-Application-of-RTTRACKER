import os
import cv2
import time
import base64
import threading
from flask import Flask, render_template, Response, request, jsonify
from ultralytics import YOLO
import os

app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = 'uploads'
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)


# Fetch default config, but we no longer override on boot for all users
default_config = {
    'model_name': 'yolov8n.pt', 
    'confidence': 0.45,
    'iou': 0.45 
}

app_config = default_config.copy()

model = None

def load_model(model_name):
    global model
    try:
        print(f"Loading YOLO model: {model_name}...")
        model = YOLO(model_name)
        return True
    except Exception as e:
        print(f"Error loading model {model_name}: {e}")
        return False

load_model(app_config['model_name'])
model_lock = threading.Lock()

# The model now detects all 80 standard COCO classes for the presentation.
# Available objects include: Person, Car, Bench, Clock (Watches), Laptop, Phone, Book, etc.
TARGET_CLASSES = None 

analytics_state = {
    'objects_detected': {},
    'fps': 0.0,
    'total_objects': 0
}

def process_frame(frame, tracking=True):
    start_time = time.time()
    
    if model is None:
        return frame
        
    conf_thresh = app_config['confidence']
    iou_thresh = app_config['iou']
        
    with model_lock:
        if tracking:
            # Use imgsz=320 to drastically accelerate CPU processing speed
            # Tracking all 80 classes to ensure maximum detection for the project
            results = model.track(frame, conf=conf_thresh, iou=iou_thresh, persist=True, verbose=False, imgsz=320)
        else:
            # For static images, we use predict. 
            # We enforce a fresh prediction to avoid tracker-related state crashes.
            results = model.predict(frame, conf=conf_thresh, iou=iou_thresh, verbose=False, imgsz=320)
        
    res = results[0]
    annotated_frame = res.plot()
    
    # Update analytics
    end_time = time.time()
    process_time = end_time - start_time
    # Avoid div by zero
    current_fps = 1.0 / process_time if process_time > 0 else 0.0
    
    analytics_state['fps'] = round(current_fps, 1)
    
    class_counts = {}
    total = 0
    if res.boxes:
        for box in res.boxes:
            cls_id = int(box.cls[0])
            cls_name = model.names[cls_id]
            class_counts[cls_name] = class_counts.get(cls_name, 0) + 1
            total += 1
            
    analytics_state['objects_detected'] = class_counts
    analytics_state['total_objects'] = total
    
    return annotated_frame

def generate_frames(source):
    # Use DirectShow backend on Windows for reliable webcam access if source is 0
    if str(source) == '0':
        cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)
        
        # Optimize Webcam Resolution for Faster AI Processing
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        
        is_live = True
        frame_delay = 0
    else:
        source_path = os.path.join(app.config['UPLOAD_FOLDER'], source) if not os.path.exists(source) else source
        cap = cv2.VideoCapture(source_path)
        is_live = False
        video_fps = cap.get(cv2.CAP_PROP_FPS)
        frame_delay = 1.0 / video_fps if video_fps > 0 else 0.033
        
    if not cap.isOpened():
        print(f"Failed to open video source: {source}")
        return
        
    frame_count = 0
    while cap.isOpened():
        loop_start = time.time()
        
        success, frame = cap.read()
        frame_count += 1
        
        if not success:
            # For file videos, loop continuously instead of breaking
            if not is_live:
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                continue
            break
            
        # For non-live video performance: Skip alternate frames to maintain pseudo real-time speed on CPU
        if not is_live and (frame_count % 2 == 0):
            continue
        
        # Resize frame significantly to drastically speed up processing time (480x360)
        frame = cv2.resize(frame, (480, 360))
        annotated_frame = process_frame(frame, tracking=True)
        
        ret, buffer = cv2.imencode('.jpg', annotated_frame)
        if not ret:
            continue
            
        frame_bytes = buffer.tobytes()
        
        yield (b'--frame\r\n'
               b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
               
        # Dynamically pace the loop to match original video FPS (1.0x speed)
        if not is_live:
            elapsed = time.time() - loop_start
            sleep_needed = frame_delay - elapsed
            if sleep_needed > 0:
                time.sleep(sleep_needed)
            
    cap.release()

# --- Admin Routes ---
@app.route('/admin/config', methods=['GET', 'POST'])
def admin_config():
    global app_config
    
    if request.method == 'POST':
        data = request.json
        
        # Validate data
        new_model = data.get('model_name')
        new_conf = float(data.get('confidence', app_config['confidence']))
        new_iou = float(data.get('iou', app_config['iou']))
        
        # Load new model if changed dynamically
        if new_model and new_model != app_config['model_name']:
            if load_model(new_model):
                app_config['model_name'] = new_model
            else:
                return jsonify({'success': False, 'message': 'Failed to load model'})
                
        app_config['confidence'] = new_conf
        app_config['iou'] = new_iou
            
        return jsonify({'success': True, 'config': app_config})
        
    return jsonify(app_config)

# --- App Routes ---
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/video')
def video():
    # 0 is the default webcam
    return Response(generate_frames(0), mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/upload_image', methods=['POST'])
def upload_image():
    if 'image' not in request.files:
        return jsonify({'error': 'No image provided'}), 400
        
    file = request.files['image']
    if file.filename == '':
        return jsonify({'error': 'Empty filename'}), 400
        
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], file.filename)
    file.save(filepath)
    
    frame = cv2.imread(filepath)
    if frame is None:
        return jsonify({'error': 'Invalid image format'}), 400
        
    # Standardize image size to 640x480 to match webcam buffers & prevent tracker state size crashes
    frame = cv2.resize(frame, (640, 480))
    annotated_frame = process_frame(frame, tracking=False)
    
    ret, buffer = cv2.imencode('.jpg', annotated_frame)
    if not ret:
        return jsonify({'error': 'Could not encode processed image'}), 500
        
    img_base64 = base64.b64encode(buffer).decode('utf-8')
    return jsonify({'image': img_base64})

@app.route('/upload_video', methods=['POST'])
def upload_video():
    if 'video' not in request.files:
        return jsonify({'error': 'No video provided'}), 400
        
    file = request.files['video']
    if file.filename == '':
        return jsonify({'error': 'Empty filename'}), 400
        
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], file.filename)
    file.save(filepath)
    return jsonify({'video_url': f'/video_file/{file.filename}'})

@app.route('/video_file/<filename>')
def video_file(filename):
    return Response(generate_frames(filename), mimetype='multipart/x-mixed-replace; boundary=frame')
    
@app.route('/analytics_data')
def get_analytics():
    return jsonify(analytics_state)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)