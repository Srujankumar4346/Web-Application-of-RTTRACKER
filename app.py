import os
import cv2
import time
import base64
from flask import Flask, render_template, Response, request, jsonify, session, redirect, url_for
from ultralytics import YOLO
import firebase_admin
from firebase_admin import credentials, auth

app = Flask(__name__)
app.secret_key = 'cyber_rttracker_secret_2026' # Required for session management
app.config['UPLOAD_FOLDER'] = 'uploads'
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

# Application State & Config
app_config = {
    'model_name': 'yolov8s.pt', # Upgraded to Small format
    'confidence': 0.25,
    'iou': 0.45 # Added IoU for strict Non-Max Suppression
}
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

# Initialize Firebase Admin
import os

try:
    if os.path.exists('serviceAccountKey.json'):
        cred = credentials.Certificate('serviceAccountKey.json')
        firebase_app = firebase_admin.initialize_app(cred)
    else:
        # Fallback to default if running on cloud
        firebase_app = firebase_admin.initialize_app(options={'projectId': 'rttracker-8bb39'})
except ValueError:
    pass # App already initialized

# Removed Hardcoded Credentials
# Admin is identified by a specific email
ADMIN_EMAIL = "admin@rttracker.com"

# COCO dataset classes to track: person, car, bottle, chair, book, laptop, phone
# COCO class mapping for YOLOv8 (0-indexed):
# 0: person, 2: car, 39: bottle, 56: chair, 63: laptop, 67: cell phone, 73: book
TARGET_CLASSES = [0, 2, 39, 56, 63, 67, 73]

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
        
    if tracking:
        results = model.track(frame, conf=conf_thresh, iou=iou_thresh, persist=True, verbose=False)
    else:
        results = model.predict(frame, conf=conf_thresh, iou=iou_thresh, verbose=False)
        
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
        is_live = True
        frame_delay = 0
    else:
        source_path = os.path.abspath(source)
        cap = cv2.VideoCapture(source_path)
        is_live = False
        # Get native FPS of the video
        video_fps = cap.get(cv2.CAP_PROP_FPS)
        frame_delay = 1.0 / video_fps if video_fps > 0 else 0.033
        
    if not cap.isOpened():
        print(f"Failed to open video source: {source}")
        return
        
    while cap.isOpened():
        loop_start = time.time()
        
        success, frame = cap.read()
        if not success:
            # For file videos, loop continuously instead of breaking
            if not is_live:
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                continue
            break
            
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

# --- Auth Routes ---
@app.route('/login', methods=['POST'])
def login():
    data = request.json
    id_token = data.get('idToken')
    
    if not id_token:
        return jsonify({'success': False, 'message': 'No token provided'}), 401
        
    try:
        # Verify the Firebase ID token
        decoded_token = auth.verify_id_token(id_token)
        uid = decoded_token['uid']
        email = decoded_token.get('email', '')
        
        # Determine Role
        role = 'admin' if email == ADMIN_EMAIL else 'user'
        
        # Establish Flask Session natively so protected routes remain functional
        session['user'] = uid
        session['email'] = email
        session['role'] = role
        
        return jsonify({'success': True, 'role': role, 'email': email})
        
    except Exception as e:
        print(f"Error verifying Firebase token: {str(e)}")
        return jsonify({'success': False, 'message': 'Invalid token'}), 401

@app.route('/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'success': True})

@app.route('/user_status')
def user_status():
    if 'user' in session:
        return jsonify({'logged_in': True, 'username': session['user'], 'role': session['role']})
    return jsonify({'logged_in': False})

# --- Admin Routes ---
@app.route('/admin/config', methods=['GET', 'POST'])
def admin_config():
    if session.get('role') != 'admin':
        return jsonify({'error': 'Unauthorized'}), 403
        
    if request.method == 'POST':
        data = request.json
        new_model = data.get('model_name')
        new_conf = data.get('confidence')
        new_iou = data.get('iou')
        
        updated = False
        if new_model and new_model != app_config['model_name']:
            if load_model(new_model):
                app_config['model_name'] = new_model
                updated = True
                
        if new_conf is not None:
            try:
                conf_val = float(new_conf)
                if 0.1 <= conf_val <= 1.0:
                    app_config['confidence'] = conf_val
                    updated = True
            except ValueError:
                pass
                
        if new_iou is not None:
            try:
                iou_val = float(new_iou)
                if 0.1 <= iou_val <= 1.0:
                    app_config['iou'] = iou_val
                    updated = True
            except ValueError:
                pass
                
        return jsonify({'success': True, 'config': app_config})
    # GET
    return jsonify(app_config)

# --- App Routes ---
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/video')
def video():
    if 'user' not in session:
        return "Unauthorized", 401
    # 0 is the default webcam
    return Response(generate_frames(0), mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/video_file/<filename>')
def video_file(filename):
    if 'user' not in session:
        return "Unauthorized", 401
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    return Response(generate_frames(filepath), mimetype='multipart/x-mixed-replace; boundary=frame')

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

@app.route('/analytics_data')
def analytics_data():
    if 'user' not in session:
        return jsonify({'error': 'Unauthorized'}), 401
    return jsonify(analytics_state)

if __name__ == '__main__':
    app.run(debug=True, port=5000)
