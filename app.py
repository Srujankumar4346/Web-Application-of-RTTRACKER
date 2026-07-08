import os
import cv2
import time
import base64
import threading
import uuid
from flask import Flask, render_template, Response, request, jsonify, send_from_directory
from ultralytics import YOLO
import jwt
from dotenv import load_dotenv
from supabase import create_client, Client
import sqlite3
import json
from datetime import datetime

load_dotenv()

# --- SQLite Local Fallback Database Config ---
DB_FILE = "local_history.db"

def init_local_db():
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS detection_events (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                media_type TEXT NOT NULL,
                media_url TEXT,
                total_objects INTEGER NOT NULL,
                fps REAL NOT NULL,
                objects_detected TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"Error initializing local database: {e}")

init_local_db()

def get_local_events(user_id):
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute("""
            SELECT id, user_id, media_type, media_url, total_objects, fps, objects_detected, created_at
            FROM detection_events
            WHERE user_id = ?
            ORDER BY created_at DESC
        """, (user_id,))
        rows = cursor.fetchall()
        conn.close()
        
        events = []
        for r in rows:
            events.append({
                "id": r[0],
                "user_id": r[1],
                "media_type": r[2],
                "media_url": r[3],
                "total_objects": r[4],
                "fps": r[5],
                "objects_detected": json.loads(r[6]),
                "created_at": r[7]
            })
        return events
    except Exception as e:
        print(f"Error getting local events: {e}")
        return []

def delete_local_event(event_id, user_id):
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute("DELETE FROM detection_events WHERE id = ? AND user_id = ?", (event_id, user_id))
        conn.commit()
        conn.close()
        return True
    except Exception as e:
        print(f"Error deleting local event: {e}")
        return False

def delete_all_local_events(user_id):
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute("DELETE FROM detection_events WHERE user_id = ?", (user_id,))
        conn.commit()
        conn.close()
        return True
    except Exception as e:
        print(f"Error deleting all local events: {e}")
        return False

def delete_bulk_local_events(event_ids, user_id):
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        placeholders = ",".join("?" for _ in event_ids)
        cursor.execute(f"DELETE FROM detection_events WHERE id IN ({placeholders}) AND user_id = ?", tuple(event_ids) + (user_id,))
        conn.commit()
        conn.close()
        return True
    except Exception as e:
        print(f"Error bulk deleting local events: {e}")
        return False

app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

# Force browser to not cache static files so UI updates appear immediately
@app.after_request
def add_header(response):
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '-1'
    return response

# Initialize Supabase
supabase_url = os.environ.get("SUPABASE_URL")
supabase_key = os.environ.get("SUPABASE_KEY")
try:
    supabase: Client = create_client(supabase_url, supabase_key) if supabase_url and supabase_key else None
except Exception as e:
    print(f"Warning: Supabase client initialization failed ({e}). Running in SQLite fallback mode.")
    supabase = None

# We use the publishable key to find the JWKS endpoint
CLERK_FRONTEND_API_URL = "https://wondrous-reindeer-57.clerk.accounts.dev"
JWKS_URL = f"{CLERK_FRONTEND_API_URL}/.well-known/jwks.json"

def get_auth_user():
    """Helper to verify Clerk session from request headers."""
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        return "local_test_user"
    
    token = auth_header.split(" ")[1]
    if token == "null" or token == "":
        return "local_test_user"
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
    return "local_test_user"

# Fetch default config, but we no longer override on boot for all users
default_config = {
    'model_name': 'yolov8s.pt', 
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


analytics_state = {
    'objects_detected': {},
    'fps': 0.0,
    'total_objects': 0
}

def process_frame(frame, tracking=True):
    start_time = time.time()
    
    if model is None:
        return frame, []
        
    conf_thresh = app_config['confidence']
    iou_thresh = app_config['iou']
        
    with model_lock:
        results = model.predict(frame, conf=conf_thresh, iou=iou_thresh, verbose=False, agnostic_nms=True)
        
    res = results[0]
    annotated_frame = res.plot()
    
    # Extract class names from this single inference pass
    detected_classes = []
    if res.boxes:
        for box in res.boxes:
            cls_id = int(box.cls[0])
            detected_classes.append(model.names[cls_id])
    
    # Update analytics
    end_time = time.time()
    process_time = end_time - start_time
    current_fps = 1.0 / process_time if process_time > 0 else 0.0
    
    analytics_state['fps'] = round(current_fps, 1)
    
    class_counts = {}
    for cls_name in detected_classes:
        class_counts[cls_name] = class_counts.get(cls_name, 0) + 1
            
    analytics_state['objects_detected'] = class_counts
    analytics_state['total_objects'] = len(detected_classes)
    
    return annotated_frame, detected_classes

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
            
        # Skip frames for video performance (process 1 out of every 2 frames) to avoid CPU lag
        if not is_live and (frame_count % 2 != 0):
            continue
        
        annotated_frame, detected_classes = process_frame(frame, tracking=True)
        
        ret, buffer = cv2.imencode('.jpg', annotated_frame)
        if not ret:
            continue
            
        frame_bytes = buffer.tobytes()
        
        yield (b'--frame\r\n'
               b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
               
        # Dynamically pace the loop to match original video FPS (1.0x speed)
        if not is_live:
            elapsed = time.time() - loop_start
            sleep_needed = (frame_delay * 2) - elapsed
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
            
        annotated_frame, detected_classes = process_frame(frame, tracking=True)
        
        ret, buffer = cv2.imencode('.jpg', annotated_frame)
        if not ret:
            return jsonify({'error': 'Encoding failed'}), 500
            
        out_b64 = base64.b64encode(buffer).decode('utf-8')
        return jsonify({'image': out_b64, 'detections': list(set(detected_classes))})
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
            
        annotated_frame, detected_classes = process_frame(frame, tracking=False)
        
        ret, buffer = cv2.imencode('.jpg', annotated_frame)
        if not ret:
            return jsonify({'error': 'Could not encode processed image'}), 500
            
        # Save event data (Supabase with Local SQLite fallback)
        saved_to_supabase = False
        media_url = None
        if supabase:
            try:
                unique_filename = f"{user_id}/{uuid.uuid4()}_{file.filename}"
                supabase.storage().from_("tracking-media").upload(
                    unique_filename,
                    buffer.tobytes(),
                    file_options={"content-type": "image/jpeg"}
                )
                media_url = supabase.storage().from_("tracking-media").get_public_url(unique_filename)
                
                supabase.table("detection_events").insert({
                    "user_id": user_id,
                    "media_type": "image",
                    "media_url": media_url,
                    "total_objects": len(detected_classes),
                    "fps": analytics_state['fps'],
                    "objects_detected": {c: detected_classes.count(c) for c in set(detected_classes)}
                }).execute()
                saved_to_supabase = True
            except Exception as e:
                print(f"Supabase image upload failed: {e}. Falling back to local.")
                
        if not saved_to_supabase:
            try:
                # Save locally to uploads folder
                local_filename = f"{uuid.uuid4()}_{file.filename}"
                local_filepath = os.path.join(app.config['UPLOAD_FOLDER'], local_filename)
                with open(local_filepath, "wb") as f:
                    f.write(buffer.tobytes())
                media_url = f"/uploads/{local_filename}"
                
                # Save to local SQLite
                conn = sqlite3.connect(DB_FILE)
                cursor = conn.cursor()
                event_id = str(uuid.uuid4())
                created_at = datetime.utcnow().isoformat() + "Z"
                objects_json = json.dumps({c: detected_classes.count(c) for c in set(detected_classes)})
                
                cursor.execute("""
                    INSERT INTO detection_events (id, user_id, media_type, media_url, total_objects, fps, objects_detected, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    event_id,
                    user_id,
                    "image",
                    media_url,
                    len(detected_classes),
                    analytics_state['fps'],
                    objects_json,
                    created_at
                ))
                conn.commit()
                conn.close()
            except Exception as e:
                print(f"Local SQLite save failed: {e}")

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

        # Save event data (Supabase with Local SQLite fallback)
        saved_to_supabase = False
        media_url = None
        if supabase:
            try:
                unique_filename = f"{user_id}/{uuid.uuid4()}_{file.filename}"
                supabase.storage().from_("tracking-media").upload(
                    unique_filename,
                    filepath,
                    file_options={"content-type": "video/mp4"}
                )
                media_url = supabase.storage().from_("tracking-media").get_public_url(unique_filename)
                
                data = {
                    "user_id": user_id,
                    "media_type": "video",
                    "media_url": media_url,
                    "total_objects": 0,
                    "fps": 0.0,
                    "objects_detected": {}
                }
                supabase.table("detection_events").insert(data).execute()
                saved_to_supabase = True
            except Exception as e:
                print(f"Supabase video upload failed: {e}. Falling back to local.")
                
        if not saved_to_supabase:
            try:
                media_url = f"/uploads/{file.filename}"
                conn = sqlite3.connect(DB_FILE)
                cursor = conn.cursor()
                event_id = str(uuid.uuid4())
                created_at = datetime.utcnow().isoformat() + "Z"
                
                cursor.execute("""
                    INSERT INTO detection_events (id, user_id, media_type, media_url, total_objects, fps, objects_detected, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    event_id,
                    user_id,
                    "video",
                    media_url,
                    0,
                    0.0,
                    "{}",
                    created_at
                ))
                conn.commit()
                conn.close()
            except Exception as e:
                print(f"Local SQLite video save failed: {e}")

        return jsonify({'video_url': f'/video_file/{file.filename}'})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': f'Backend Exception: {str(e)}'}), 500

@app.route('/video_file/<filename>')
def video_file(filename):
    return Response(generate_frames(filename), mimetype='multipart/x-mixed-replace; boundary=frame')
    
@app.route('/uploads/<path:filename>')
def serve_upload(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

@app.route('/analytics_data')
def get_analytics():
    return jsonify(analytics_state)

@app.route('/log_event', methods=['POST'])
def log_event():
    user_id = get_auth_user()
    if not user_id:
        return jsonify({'error': 'Unauthorized'}), 401
    
    data = request.json
    source = data.get('source', 'Unknown')
    objects = data.get('objects', [])
    image_b64 = data.get('image', None)
    
    obj_list = objects if isinstance(objects, list) else [objects]
    
    img_data = None
    if image_b64:
        try:
            img_data = base64.b64decode(image_b64.split(',')[1] if ',' in image_b64 else image_b64)
        except Exception as e:
            print(f"Failed to decode base64: {e}")
            
    media_url = None
    saved_to_supabase = False
    
    if supabase:
        try:
            if img_data:
                unique_filename = f"{user_id}/{uuid.uuid4()}_event.jpg"
                supabase.storage().from_("tracking-media").upload(
                    unique_filename,
                    img_data,
                    file_options={"content-type": "image/jpeg"}
                )
                media_url = supabase.storage().from_("tracking-media").get_public_url(unique_filename)
                
            insert_data = {
                "user_id": user_id,
                "media_type": source,
                "total_objects": len(obj_list),
                "fps": 0.0,
                "objects_detected": {c: obj_list.count(c) for c in set(obj_list)}
            }
            if media_url:
                insert_data["media_url"] = media_url
                
            supabase.table("detection_events").insert(insert_data).execute()
            saved_to_supabase = True
        except Exception as e:
            print(f"Supabase log event failed: {e}. Falling back to local.")
            
    if not saved_to_supabase:
        try:
            if img_data:
                local_filename = f"{uuid.uuid4()}_event.jpg"
                local_filepath = os.path.join(app.config['UPLOAD_FOLDER'], local_filename)
                with open(local_filepath, "wb") as f:
                    f.write(img_data)
                media_url = f"/uploads/{local_filename}"
                
            conn = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            event_id = str(uuid.uuid4())
            created_at = datetime.utcnow().isoformat() + "Z"
            objects_json = json.dumps({c: obj_list.count(c) for c in set(obj_list)})
            
            cursor.execute("""
                INSERT INTO detection_events (id, user_id, media_type, media_url, total_objects, fps, objects_detected, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                event_id,
                user_id,
                source,
                media_url,
                len(obj_list),
                0.0,
                objects_json,
                created_at
            ))
            conn.commit()
            conn.close()
        except Exception as e:
            print(f"Local SQLite log event failed: {e}")
            return jsonify({'error': str(e)}), 500
            
    return jsonify({'success': True})

@app.route('/history')
def get_history():
    user_id = get_auth_user()
    if not user_id:
        return jsonify({'error': 'Unauthorized'}), 401
    
    if supabase:
        try:
            response = supabase.table("detection_events") \
                .select("*") \
                .eq("user_id", user_id) \
                .order("created_at", desc=True) \
                .execute()
            return jsonify(response.data)
        except Exception as e:
            print(f"Supabase history fetch failed: {e}. Falling back to local SQLite.")
            
    # Local fallback
    return jsonify(get_local_events(user_id))

@app.route('/history/<event_id>', methods=['DELETE'])
def delete_history_event(event_id):
    user_id = get_auth_user()
    if not user_id:
        return jsonify({'error': 'Unauthorized'}), 401
    
    if supabase:
        try:
            supabase.table("detection_events").delete().eq("id", event_id).eq("user_id", user_id).execute()
        except Exception as e:
            print(f"Supabase event delete failed: {e}. Removing locally.")
            
    delete_local_event(event_id, user_id)
    return jsonify({'success': True})

@app.route('/history/all', methods=['DELETE'])
def delete_all_history():
    user_id = get_auth_user()
    if not user_id:
        return jsonify({'error': 'Unauthorized'}), 401
    
    if supabase:
        try:
            supabase.table("detection_events").delete().eq("user_id", user_id).execute()
        except Exception as e:
            print(f"Supabase delete all failed: {e}. Removing locally.")
            
    delete_all_local_events(user_id)
    return jsonify({'success': True})

@app.route('/history/bulk', methods=['DELETE'])
def delete_bulk_history():
    user_id = get_auth_user()
    if not user_id:
        return jsonify({'error': 'Unauthorized'}), 401
    
    data = request.json
    event_ids = data.get('event_ids', [])
    
    if not event_ids:
        return jsonify({'error': 'No event IDs provided'}), 400
        
    if supabase:
        try:
            supabase.table("detection_events").delete().in_("id", event_ids).eq("user_id", user_id).execute()
        except Exception as e:
            print(f"Supabase bulk delete failed: {e}. Removing locally.")
            
    delete_bulk_local_events(event_ids, user_id)
    return jsonify({'success': True})

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)