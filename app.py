import os
import cv2
import time
import base64
import threading
import uuid
from flask import Flask, render_template, Response, request, jsonify
from ultralytics import YOLO
import jwt
import requests
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024 # Limit uploads to 16MB to prevent Cloud OOM kills
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

# Initialize Supabase
supabase_url = os.environ.get("SUPABASE_URL")
supabase_key = os.environ.get("SUPABASE_KEY")
supabase: Client = create_client(supabase_url, supabase_key) if supabase_url and supabase_key else None

# We use the publishable key to find the JWKS endpoint
CLERK_FRONTEND_API_URL = "https://wondrous-reindeer-57.clerk.accounts.dev"
JWKS_URL = f"{CLERK_FRONTEND_API_URL}/.well-known/jwks.json"

def get_auth_user():
    """Helper to verify Clerk session from request headers."""
    auth_header = request.headers.get("Authorization")
    print(f"[AUTH DEBUG] Auth header present: {bool(auth_header)}")
    if not auth_header or not auth_header.startswith("Bearer "):
        print("[AUTH DEBUG] Missing or invalid Authorization header format.")
        return None
    
    token = auth_header.split(" ")[1]
    print(f"[AUTH DEBUG] Token length: {len(token)}")
    try:
        # Fetch the public keys from Clerk
        jwks_client = jwt.PyJWKClient(JWKS_URL)
        signing_key = jwks_client.get_signing_key_from_jwt(token)

        # Verify and decode the JWT
        payload = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            leeway=60, # Allow for 60 seconds of clock skew
            options={
                "verify_aud": False,
                "verify_iss": False
            }
        )
        user_id = payload.get("sub")
        return user_id
    except jwt.ExpiredSignatureError:
        print("[AUTH DEBUG] Token has expired.")
    except jwt.InvalidTokenError as e:
        print(f"[AUTH DEBUG] Invalid token: {e}")
    except Exception as e:
        print(f"[AUTH DEBUG] Unexpected Auth error: {e}")
    return None

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
            # Removed imgsz to restore detection accuracy
            results = model.track(frame, conf=conf_thresh, iou=iou_thresh, persist=True, verbose=False)
        else:
            # Removed imgsz to restore detection accuracy
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
        if not cap.isOpened():
            print("CAP_DSHOW failed, falling back to default backend...")
            cap = cv2.VideoCapture(0)
        
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
        
        # Handle Windows Webcam Buffer Lag
        if is_live:
            for _ in range(4):
                cap.grab()
                
        success, frame = cap.read()
        frame_count += 1
        
        if not success:
            # For file videos, loop continuously instead of breaking
            if not is_live:
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                continue
            break
            
        # Skip alternate frames for video performance if needed
        if not is_live and (frame_count % 2 == 0):
            continue
        
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

@app.route('/process_webcam_frame', methods=['POST'])
def process_webcam_frame():
    try:
        user_id = get_auth_user()
        if not user_id:
            return jsonify({'error': 'Unauthorized'}), 401
            
        data = request.json
        img_b64 = data.get('image', '')
        if not img_b64 or ',' not in img_b64:
            return jsonify({'error': 'No image data'}), 400
            
        img_b64 = img_b64.split(',')[1]
        img_data = base64.b64decode(img_b64)
        
        import numpy as np
        nparr = np.frombuffer(img_data, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        if frame is None:
            return jsonify({'error': 'Invalid framedata'}), 400
            
        annotated_frame = process_frame(frame, tracking=True)
        
        # Extract current detections for the incident log
        detections = []
        with model_lock:
            # Re-run prediction just to get the raw classes easily without altering global trackers
            # since process_frame only returns the annotated image
            results = model(frame, verbose=False, conf=app_config['confidence'])
            if len(results) > 0 and results[0].boxes:
                for box in results[0].boxes:
                    cls_id = int(box.cls[0])
                    detections.append(model.names[cls_id])
        
        ret, buffer = cv2.imencode('.jpg', annotated_frame)
        if not ret:
            return jsonify({'error': 'Encoding failed'}), 500
            
        out_b64 = base64.b64encode(buffer).decode('utf-8')
        return jsonify({'image': out_b64, 'detections': list(set(detections))})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/upload_image', methods=['POST'])
def upload_image():
    user_id = get_auth_user()
    if not user_id:
        # Require authentication to upload and track analytics
        return jsonify({'error': 'Unauthorized: Please sign in to detect targets.'}), 401

    try:
        if 'image' not in request.files:
            return jsonify({'error': 'No image provided'}), 400
            
        file = request.files['image']
        if file.filename == '':
            return jsonify({'error': 'Empty filename'}), 400
            
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], file.filename)
        file.save(filepath)
        
        frame = cv2.imread(filepath)
        if frame is None:
            try:
                from PIL import Image
                import numpy as np
                try:
                    import pillow_heif
                    pillow_heif.register_heif_opener()
                except ImportError:
                    print("pillow-heif not available, HEIC uploads will fail.")
                
                pil_img = Image.open(filepath).convert('RGB')
                frame = np.array(pil_img)
                frame = frame[:, :, ::-1].copy() # Convert RGB to BGR
            except Exception as e:
                return jsonify({'error': f'Unsupported image format: {file.filename}'}), 400
            
        annotated_frame = process_frame(frame, tracking=False)
        
        ret, buffer = cv2.imencode('.jpg', annotated_frame)
        if not ret:
            return jsonify({'error': 'Could not encode processed image'}), 500
            
        # Save event data to Supabase
        if supabase:
            try:
                # Upload the raw uploaded file first
                unique_filename = f"{user_id}/{uuid.uuid4()}_{file.filename}"
                # Pass the filepath string directly to 'upload' instead of a file object
                supabase.storage.from_("tracking-media").upload(
                    unique_filename,
                    filepath,
                    file_options={"content-type": "image/jpeg"}
                )
                media_url = supabase.storage.from_("tracking-media").get_public_url(unique_filename)
                
                # Save the analytics state associated with this specific prediction
                # Since predict updates globals, we grab current analytics_state
                data = {
                    "user_id": user_id,
                    "media_type": "image",
                    "media_url": media_url,
                    "total_objects": analytics_state['total_objects'],
                    "fps": analytics_state['fps'],
                    "objects_detected": analytics_state['objects_detected']
                }
                supabase.table("detection_events").insert(data).execute()
            except Exception as e:
                print(f"Supabase sync err: {e}")

        img_base64 = base64.b64encode(buffer).decode('utf-8')
        return jsonify({'image': img_base64})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': f'Backend Exception: {str(e)}'}), 500

@app.route('/upload_video', methods=['POST'])
def upload_video():
    user_id = get_auth_user()
    if not user_id:
        return jsonify({'error': 'Unauthorized: Please sign in to detect targets.'}), 401
    
    try:
        if 'video' not in request.files:
            return jsonify({'error': 'No video provided'}), 400
            
        file = request.files['video']
        if file.filename == '':
            return jsonify({'error': 'Empty filename'}), 400
            
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], file.filename)
        file.save(filepath)

        # Save event data to Supabase
        if supabase:
            try:
                # Upload the raw uploaded video file
                unique_filename = f"{user_id}/{uuid.uuid4()}_{file.filename}"
                # Pass the filepath string directly to 'upload' instead of a file object
                supabase.storage.from_("tracking-media").upload(
                    unique_filename,
                    filepath,
                    file_options={"content-type": "video/mp4"}
                )
                media_url = supabase.storage.from_("tracking-media").get_public_url(unique_filename)
                
                # Save generic analytics state associated with starting the video
                data = {
                    "user_id": user_id,
                    "media_type": "video",
                    "media_url": media_url,
                    "total_objects": 0, # Objects updated live during processing via websockets/polling usually
                    "fps": 0.0,
                    "objects_detected": {}
                }
                supabase.table("detection_events").insert(data).execute()
            except Exception as e:
                print(f"Supabase sync err: {e}")

        return jsonify({'video_url': f'/video_file/{file.filename}'})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': f'Backend Exception: {str(e)}'}), 500

@app.route('/video_file/<filename>')
def video_file(filename):
    return Response(generate_frames(filename), mimetype='multipart/x-mixed-replace; boundary=frame')
    
@app.route('/analytics_data')
def get_analytics():
    return jsonify(analytics_state)


@app.route('/history')
def get_history():
    user_id = get_auth_user()
    if not user_id:
        return jsonify({'error': 'Unauthorized'}), 401
    
    if not supabase:
        return jsonify({'error': 'Supabase not configured'}), 500
        
    try:
        response = supabase.table("detection_events") \
            .select("*") \
            .eq("user_id", user_id) \
            .order("created_at", desc=True) \
            .execute()
        return jsonify(response.data)
    except Exception as e:
        print(f"History fetch err: {e}")
        return jsonify({'error': str(e)}), 500

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)