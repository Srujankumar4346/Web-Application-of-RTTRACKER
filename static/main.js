document.addEventListener('DOMContentLoaded', () => {

    // --- Navigation logic for Single Page App ---
    const navBtns = document.querySelectorAll('.nav-btn');
    const sections = document.querySelectorAll('.page-section');

    const adminPanel = document.getElementById('admin-panel');

    let pollInterval = null;

    window.switchTab = function (targetId) {
        navBtns.forEach(btn => {
            if (btn.dataset.target === targetId) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });

        sections.forEach(sec => {
            if (sec.id === targetId) {
                sec.classList.add('active');
            } else {
                sec.classList.remove('active');
            }
        });

        // Stop webcam feed if leaving simulation
        if (targetId !== 'simulation') {
            stopWebcamMode();
        }
    };

    navBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            switchTab(e.target.dataset.target);
        });
    });

    // --- Simulation Modes Toggle ---
    const modeBtns = document.querySelectorAll('.mode-btn');
    const modePanels = document.querySelectorAll('.mode-panel');

    modeBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const mode = e.target.dataset.mode;

            modeBtns.forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');

            modePanels.forEach(p => p.classList.remove('active'));
            document.getElementById(`mode-${mode}`).classList.add('active');

            resetDisplay();
        });
    });

    // --- Media Display Handling ---
    const resultDisplay = document.getElementById('result-display');
    const placeholderText = document.getElementById('placeholder-text');
    const loading = document.getElementById('loading');

    function showLoading() {
        resultDisplay.style.display = 'none';
        placeholderText.style.display = 'none';
        loading.style.display = 'block';
    }

    function showResult(src) {
        loading.style.display = 'none';
        placeholderText.style.display = 'none';

        // Prevent browser caching the video feed URL which causes infinite loading
        if (src.includes('/video')) {
            resultDisplay.src = src + '?t=' + new Date().getTime();
        } else {
            resultDisplay.src = src;
        }

        resultDisplay.style.display = 'block';
    }

    function resetDisplay() {
        resultDisplay.style.display = 'none';
        resultDisplay.src = '';
        loading.style.display = 'none';
        placeholderText.style.display = 'block';
        placeholderText.textContent = "AWAITING FEED...";
        stopWebcamMode();
    }

    // --- Webcam Capture via Browser (Cloud Compatible) ---
    const startWebcamBtn = document.getElementById('start-webcam');
    const stopWebcamBtn = document.getElementById('stop-webcam');
    const clientWebcam = document.getElementById('client-webcam');
    const clientCanvas = document.getElementById('client-canvas');
    let webcamStream = null;
    let webcamInterval = null;

    function stopWebcamMode() {
        if (startWebcamBtn) startWebcamBtn.style.display = 'inline-block';
        if (stopWebcamBtn) stopWebcamBtn.style.display = 'none';

        if (webcamInterval) {
            clearInterval(webcamInterval);
            webcamInterval = null;
        }
        if (webcamStream) {
            webcamStream.getTracks().forEach(track => track.stop());
            webcamStream = null;
        }
        if (clientWebcam) clientWebcam.srcObject = null;

        resultDisplay.src = '';
    }

    if (startWebcamBtn) {
        startWebcamBtn.addEventListener('click', async () => {
            try {
                webcamStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
                clientWebcam.srcObject = webcamStream;
                startWebcamBtn.style.display = 'none';
                stopWebcamBtn.style.display = 'inline-block';
                loading.style.display = 'none';
                placeholderText.style.display = 'none';

                // Show the raw webcam video immediately while we wait for the first annotated frame
                clientWebcam.style.display = 'block';
                resultDisplay.style.display = 'none';

                // Process frames rapidly, using 'isWebcamProcessing' lock to prevent queueing
                webcamInterval = setInterval(processWebcamFrame, 50);
            } catch (err) {
                console.error(err);
                alert("Could not access your camera: " + err.message);
                resetDisplay();
            }
        });
    }

    if (stopWebcamBtn) {
        stopWebcamBtn.addEventListener('click', () => {
            resetDisplay();
        });
    }

    let isWebcamProcessing = false;

    async function processWebcamFrame() {
        if (!clientWebcam || !clientCanvas || !clientWebcam.videoWidth) return;
        if (isWebcamProcessing) return;

        isWebcamProcessing = true;

        clientCanvas.width = clientWebcam.videoWidth;
        clientCanvas.height = clientWebcam.videoHeight;
        const ctx = clientCanvas.getContext('2d');
        ctx.drawImage(clientWebcam, 0, 0, clientCanvas.width, clientCanvas.height);

        // Compress heavily for cloud uploads (0.6 quality JPEG at 640px)
        const smallCanvas = document.createElement('canvas');
        smallCanvas.width = 640;
        smallCanvas.height = Math.round(clientCanvas.height * 640 / clientCanvas.width);
        const sCtx = smallCanvas.getContext('2d');
        sCtx.drawImage(clientCanvas, 0, 0, smallCanvas.width, smallCanvas.height);
        const base64Data = smallCanvas.toDataURL('image/jpeg', 0.6);

        try {
            const token = window.Clerk && Clerk.session ? await Clerk.session.getToken() : null;
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers['Authorization'] = `Bearer ${token}`;

            const response = await fetch('/process_webcam_frame', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ image: base64Data })
            });

            if (response.status === 401) {
                stopWebcamMode();
                alert("Please sign in to detect targets.");
                return;
            }

            const data = await response.json();
            if (data.image) {
                // First annotated frame received — switch from raw video to annotated result
                clientWebcam.style.display = 'none';
                resultDisplay.style.display = 'block';
                resultDisplay.src = `data:image/jpeg;base64,${data.image}`;

                // Log detections from Webcam to the History DB
                if (data.detections && data.detections.length > 0) {
                    if (!window.webcamLogCooldowns) window.webcamLogCooldowns = {};
                    const now = Date.now();
                    
                    data.detections.forEach(threat => {
                        // Max 1 log every 10 seconds per unique object class to prevent database spam
                        if (!window.webcamLogCooldowns[threat] || now - window.webcamLogCooldowns[threat] > 10000) {
                            if (typeof window.logDetectionEvent === 'function') {
                                window.logDetectionEvent('webcam', [threat], data.image);
                            }
                            window.webcamLogCooldowns[threat] = now;
                        }
                    });
                }
            }
        } catch (err) {
            console.error("Frame dropped:", err);
        } finally {
            isWebcamProcessing = false;
        }
    }

    // --- File Input Labels updating ---
    const imgInput = document.getElementById('image-input');
    if (imgInput) {
        imgInput.addEventListener('change', function () {
            if (this.files.length > 1) {
                document.getElementById('img-file-name').textContent = `${this.files.length} files selected`;
            } else {
                document.getElementById('img-file-name').textContent = this.files[0] ? this.files[0].name : '';
            }
        });
    }

    const vidInput = document.getElementById('video-input');
    if (vidInput) {
        vidInput.addEventListener('change', function () {
            if (this.files.length > 1) {
                document.getElementById('vid-file-name').textContent = `${this.files.length} files selected`;
            } else {
                document.getElementById('vid-file-name').textContent = this.files[0] ? this.files[0].name : '';
            }
        });
    }

    // --- Image Upload ---
    const imgForm = document.getElementById('image-upload-form');
    const gridDisplay = document.getElementById('grid-display');

    if (imgForm) {
        imgForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const fileInput = document.getElementById('image-input');
            const totalFiles = fileInput.files.length;
            if (!totalFiles) return alert('Please select images first.');

            const fileNameDisplay = document.getElementById('img-file-name');

            if (totalFiles === 1) {
                // Single image behavior
                gridDisplay.style.display = 'none';
                resultDisplay.style.display = 'block';
                await processSingleImage(fileInput.files[0], fileNameDisplay);
            } else {
                // Multi-image grid behavior (batches of 4)
                resultDisplay.style.display = 'none';
                gridDisplay.style.display = 'grid';

                for (let i = 0; i < totalFiles; i += 4) {
                    // Clear previous grid slots if starting a new batch
                    for (let s = 0; s < 4; s++) {
                        const slot = document.getElementById(`slot-${s}`);
                        slot.src = '';
                        slot.parentElement.style.opacity = '0.3';
                    }

                    const batch = Array.from(fileInput.files).slice(i, i + 4);
                    const batchPromises = batch.map(async (file, index) => {
                        const slotIdx = index;
                        const slotImg = document.getElementById(`slot-${slotIdx}`);
                        const slotParent = slotImg.parentElement;

                        fileNameDisplay.textContent = `Processing ${i + index + 1} of ${totalFiles}...`;

                        const formData = new FormData();
                        formData.append('image', file);

                        try {
                            const token = await Clerk.session.getToken();
                            const response = await fetch('/upload_image', {
                                method: 'POST',
                                body: formData,
                                headers: { 'Authorization': `Bearer ${token}` }
                            });
                            const data = await response.json();
                            if (data.error) {
                                console.error('Image processing error:', data.error);
                                alert('Error: ' + data.error);
                            } else if (data.image) {
                                slotImg.src = `data:image/jpeg;base64,${data.image}`;
                                slotParent.style.opacity = '1';
                            }
                        } catch (err) {
                            console.error(err);
                        }
                    });

                    await Promise.all(batchPromises);

                    // Wait 4 seconds for user to view the batch of 4 before next set
                    if (i + 4 < totalFiles) {
                        fileNameDisplay.textContent = `Batch complete. Waiting 4s...`;
                        await new Promise(r => setTimeout(r, 4000));
                    }
                }
                fileNameDisplay.textContent = `${totalFiles} images processed.`;
            }
        });
    }

    // Compress an image File to a FormData-ready Blob via canvas (max 640px, 75% JPEG)
    function compressImageFile(file) {
        return new Promise((resolve) => {
            const img = new Image();
            const url = URL.createObjectURL(file);
            img.onload = () => {
                URL.revokeObjectURL(url);
                const MAX = 640;
                let { width, height } = img;
                if (width > MAX || height > MAX) {
                    if (width > height) { height = Math.round(height * MAX / width); width = MAX; }
                    else { width = Math.round(width * MAX / height); height = MAX; }
                }
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                canvas.toBlob(resolve, 'image/jpeg', 0.75);
            };
            img.onerror = () => resolve(file); // fallback: send original
            img.src = url;
        });
    }

    async function processSingleImage(file, display) {
        showLoading();
        display.textContent = `Compressing: ${file.name}`;

        // Compress on the client before sending to avoid OOM on Render
        const compressed = await compressImageFile(file);

        display.textContent = `Processing: ${file.name}`;
        const formData = new FormData();
        formData.append('image', compressed, file.name);

        try {
            const token = window.Clerk && window.Clerk.session ? await window.Clerk.session.getToken() : null;
            const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

            const response = await fetch('/upload_image', {
                method: 'POST',
                body: formData,
                headers: headers
            });

            if (response.status === 401) {
                alert("Please sign in to run detections!");
                resetDisplay();
                return;
            }

            if (response.status === 413) {
                alert("Image file is too large! Please use an image under 16MB.");
                resetDisplay();
                return;
            }

            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                const text = await response.text();
                console.error("Non-JSON response (HTTP " + response.status + "):", text.substring(0, 300));
                alert(`Server error (HTTP ${response.status}). Please try again in a moment.`);
                resetDisplay();
                return;
            }

            const data = await response.json();

            if (data.error) {
                alert("Error: " + data.error);
                resetDisplay();
                return;
            }

            if (data.image) {
                showResult(`data:image/jpeg;base64,${data.image}`);
                // Logging is now handled securely on the backend in app.py directly.
            }
        } catch (err) {
            console.error(err);
            alert("Network error: " + err.message + ". The server may be starting up — wait 30 seconds and try again.");
            resetDisplay();
        } finally {
            // Ensure any temporary display text is cleared if not in result mode
            if (resultDisplay.style.display !== 'block') {
                resetDisplay();
            }
        }
    }

    // --- Video Upload ---
    const vidForm = document.getElementById('video-upload-form');
    if (vidForm) {
        vidForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const fileInput = document.getElementById('video-input');
            if (!fileInput.files.length) return alert('Please select video files.');

            for (let i = 0; i < fileInput.files.length; i++) {
                showLoading();
                const file = fileInput.files[i];
                const formData = new FormData();
                formData.append('video', file);

                const fileNameEl = document.getElementById('vid-file-name');
                if (fileNameEl) fileNameEl.textContent = `Uploading ${file.name}... (may take up to 90s)`;

                // AbortController gives us a clean 90-second timeout
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 90000);

                try {
                    const token = window.Clerk && window.Clerk.session ? await window.Clerk.session.getToken() : null;
                    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

                    const response = await fetch('/upload_video', {
                        method: 'POST',
                        body: formData,
                        headers: headers,
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);

                    if (response.status === 401) {
                        alert("Please sign in to run detections!");
                        resetDisplay();
                        return;
                    }

                    const contentType = response.headers.get('content-type');
                    if (!contentType || !contentType.includes('application/json')) {
                        alert(`Server error (HTTP ${response.status}). Video may be too large — try a shorter clip under 30 seconds.`);
                        resetDisplay();
                        continue;
                    }

                    const data = await response.json();

                    if (data.error) {
                        alert(`Error on ${file.name}: ${data.error}`);
                        continue;
                    }

                    showResult(data.video_url);

                    if (i < fileInput.files.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 10000));
                    }
                } catch (err) {
                    clearTimeout(timeoutId);
                    if (err.name === 'AbortError') {
                        alert(`Video processing timed out for "${file.name}". Please try a shorter clip (under 30 seconds).`);
                    } else {
                        alert(`Upload failed for "${file.name}": ${err.message}`);
                    }
                    resetDisplay();
                } finally {
                    if (fileNameEl) fileNameEl.textContent = '';
                }
            }
        });
    }

    // --- Analytics API Polling ---
    async function fetchAnalytics() {
        try {
            const res = await fetch('/analytics_data');
            const data = await res.json();
            updateDashboard(data);
        } catch (err) {
            // Silently fail connection errors for polling
            console.warn('Analytics polling failed:', err);
        }
    }

    // --- Number Animation Function ---
    function animateValue(obj, start, end, duration, formatter = (v) => v) {
        let startTimestamp = null;
        const step = (timestamp) => {
            if (!startTimestamp) startTimestamp = timestamp;
            const progress = Math.min((timestamp - startTimestamp) / duration, 1);
            obj.textContent = formatter(Math.floor(progress * (end - start) + start));
            if (progress < 1) {
                window.requestAnimationFrame(step);
            }
        };
        window.requestAnimationFrame(step);
    }

    let lastData = { confidence: 0, total: 0, fps: 0, accuracy: 85, motion: 10 };

    // --- Chart.js Initialization ---
    Chart.defaults.color = '#84c0c6';
    Chart.defaults.font.family = "'Rajdhani', sans-serif";

    const barCtx = document.getElementById('barChart');
    let barChartInst = null;
    if (barCtx) {
        barChartInst = new Chart(barCtx, {
            type: 'bar',
            data: { labels: [], datasets: [{ label: 'Targets detected', data: [], backgroundColor: '#00ffff', borderRadius: 4, borderWidth: 1, borderColor: 'rgba(0, 255, 255, 0.8)' }] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { color: 'rgba(0, 255, 255, 0.1)' } },
                    y: { beginAtZero: true, ticks: { stepSize: 1 }, grid: { color: 'rgba(0, 255, 255, 0.1)' } }
                },
                animation: { duration: 400 }
            }
        });
    }

    const lineCtx = document.getElementById('lineChart');
    let lineChartInst = null;
    if (lineCtx) {
        lineChartInst = new Chart(lineCtx, {
            type: 'line',
            data: { labels: [], datasets: [{ label: 'Total Objects', data: [], borderColor: '#00ffff', backgroundColor: 'rgba(0, 255, 255, 0.1)', borderWidth: 2, fill: true, tension: 0.4 }] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { color: 'rgba(0, 255, 255, 0.1)' }, ticks: { maxTicksLimit: 10 } },
                    y: { beginAtZero: true, grid: { color: 'rgba(0, 255, 255, 0.1)' }, suggestedMax: 10 }
                },
                animation: { duration: 0 } // Disable animation for heartbeat effect
            }
        });
    }

    const radarCtx = document.getElementById('radarChart');
    let radarChartInst = null;
    if (radarCtx) {
        radarChartInst = new Chart(radarCtx, {
            type: 'radar',
            data: { labels: ['Searching'], datasets: [{ label: 'Composition', data: [0], backgroundColor: 'rgba(176, 0, 255, 0.3)', borderColor: '#b000ff', pointBackgroundColor: '#00ffff', borderWidth: 2 }] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    r: {
                        angleLines: { color: 'rgba(0, 255, 255, 0.2)' },
                        grid: { color: 'rgba(0, 255, 255, 0.2)' },
                        pointLabels: { color: '#84c0c6', font: { size: 11 } },
                        ticks: { display: false, beginAtZero: true }
                    }
                },
                animation: { duration: 400 }
            }
        });
    }

    const pieCtx = document.getElementById('pieChart');
    let pieChartInst = null;
    if (pieCtx) {
        pieChartInst = new Chart(pieCtx, {
            type: 'doughnut',
            data: {
                labels: [],
                datasets: [{
                    data: [],
                    backgroundColor: ['#00ffff', '#b000ff', '#ff0055', '#00ffaa', '#ffff00', '#ffa500', '#ff00ff'],
                    borderWidth: 1,
                    borderColor: '#050a15'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'right' }
                },
                cutout: '65%',
                animation: { duration: 400 }
            }
        });
    }

    function updateDashboard(data) {
        const fps = data.fps || 0;
        const total = data.total_objects || 0;
        const objs = data.objects_detected || {};

        // Generate pseudo-metrics based on detection status for visual effect
        const confidence = total > 0 ? 88 + Math.floor(Math.random() * 8) : 0;
        const accuracy = total > 0 ? 92 + Math.floor(Math.random() * 5) : 85;
        const motion = total > 0 ? 40 + Math.floor(Math.random() * 40) : 10;

        // --- Animated Top Stats ---
        animateValue(document.getElementById('val-confidence'), lastData.confidence, confidence, 500, v => `${v}%`);
        animateValue(document.getElementById('val-objects'), lastData.total, total, 500);
        document.getElementById('val-ptime').textContent = fps > 0 ? `${Math.round(1000 / fps)} ms` : '0 ms';
        animateValue(document.getElementById('val-fps'), Math.floor(lastData.fps), Math.floor(fps), 500, v => `${v.toFixed(1)}`);

        // --- Live Event Stream Logic ---
        const eventStream = document.getElementById('event-stream');
        if (eventStream && total > 0) {
            const timeStr = new Date().toLocaleTimeString();
            // Create a short summary of objects detected
            const objSummary = Object.entries(objs).map(([k, v]) => `${v}x ${k}`).join(', ');
            const newLog = document.createElement('div');
            newLog.style.animation = 'fadeIn 0.5s';
            // Alternating colors for logs
            const color = Math.random() > 0.5 ? 'var(--neon-cyan)' : '#b000ff';
            newLog.innerHTML = `<span style="color:${color}">[${timeStr}]</span> Target Acquired &bull; ${objSummary} &bull; Conf: ${confidence}%`;
            eventStream.appendChild(newLog);

            // Keep only latest 50 logs
            if (eventStream.children.length > 50) {
                eventStream.removeChild(eventStream.firstChild);
            }
            // Auto scroll to bottom
            eventStream.scrollTop = eventStream.scrollHeight;
        } else if (eventStream && Object.keys(objs).length === 0 && Math.random() > 0.7) {
            // Occasional idle log
            const timeStr = new Date().toLocaleTimeString();
            const newLog = document.createElement('div');
            newLog.style.color = 'var(--text-muted)';
            newLog.innerHTML = `[${timeStr}] System Idle. Scanning sector...`;
            eventStream.appendChild(newLog);
            if (eventStream.children.length > 50) eventStream.removeChild(eventStream.firstChild);
            eventStream.scrollTop = eventStream.scrollHeight;
        }

        // Update Detected Objects List (Bottom Grid)
        const listContainer = document.getElementById('objects-list');
        listContainer.innerHTML = '';

        if (Object.entries(objs).length === 0) {
            listContainer.innerHTML = `<div class="obj-item empty" style="animation: fadeIn 0.5s;">No targets engaged</div>`;
        } else {
            let delay = 0;
            for (const [cls, count] of Object.entries(objs)) {
                listContainer.innerHTML += `<div class="obj-item pop-in" style="animation-delay: ${delay}s">${cls} <span class="count">${count}</span></div>`;
                delay += 0.1;
            }
        }

        // --- Update Chart.js Graphics ---
        const labels = Object.keys(objs);
        const counts = Object.values(objs);

        if (lineChartInst) {
            // Heartbeat monitor logic: push new data, shift old data
            const timeLabel = new Date().toLocaleTimeString([], { hour12: false });
            lineChartInst.data.labels.push(timeLabel);
            lineChartInst.data.datasets[0].data.push(total);

            // Keep max 20 data points on screen
            if (lineChartInst.data.labels.length > 20) {
                lineChartInst.data.labels.shift();
                lineChartInst.data.datasets[0].data.shift();
            }
            lineChartInst.update('none'); // Update without animation for a smoother rolling effect
        }

        if (radarChartInst && labels.length > 0) {
            radarChartInst.data.labels = labels;
            radarChartInst.data.datasets[0].data = counts;
            radarChartInst.update();
        } else if (radarChartInst) {
            // Default empty radar
            radarChartInst.data.labels = ['Searching'];
            radarChartInst.data.datasets[0].data = [0];
            radarChartInst.update();
        }

        if (barChartInst && pieChartInst) {
            barChartInst.data.labels = labels;
            barChartInst.data.datasets[0].data = counts;
            barChartInst.update('active');

            pieChartInst.data.labels = labels;
            pieChartInst.data.datasets[0].data = counts;
            pieChartInst.update('active');
        }

        // Save state for next animation frame
        lastData = { confidence, total, fps, accuracy, motion };
    }

    // --- Admin Config Logic ---
    const adminConfSlider = document.getElementById('admin-conf');
    const confValDisplay = document.getElementById('conf-val-display');
    const adminIouSlider = document.getElementById('admin-iou');
    const iouValDisplay = document.getElementById('iou-val-display');
    const adminModelSelect = document.getElementById('admin-model');
    const saveConfigBtn = document.getElementById('save-config-btn');

    adminConfSlider.addEventListener('input', (e) => {
        confValDisplay.textContent = Math.round(e.target.value * 100) + '%';
    });

    adminIouSlider.addEventListener('input', (e) => {
        iouValDisplay.textContent = Math.round(e.target.value * 100) + '%';
    });

    function fetchAdminConfig() {
        fetch('/admin/config')
            .then(r => r.json())
            .then(data => {
                adminModelSelect.value = data.model_name || 'yolov8s.pt';

                adminConfSlider.value = data.confidence || 0.45;
                confValDisplay.textContent = Math.round((data.confidence || 0.45) * 100) + '%';

                adminIouSlider.value = data.iou || 0.45;
                iouValDisplay.textContent = Math.round((data.iou || 0.45) * 100) + '%';
            });
    }

    saveConfigBtn.addEventListener('click', () => {
        const payload = {
            model_name: adminModelSelect.value,
            confidence: parseFloat(adminConfSlider.value),
            iou: parseFloat(adminIouSlider.value)
        };
        saveConfigBtn.textContent = "Saving...";
        fetch('/admin/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(r => r.json()).then(data => {
            if (data.success) {
                saveConfigBtn.textContent = "Saved!";
                setTimeout(() => saveConfigBtn.textContent = "Save Config", 2000);
            }
        });
    });

    // Start App globally
    adminPanel.style.display = 'block';
    fetchAdminConfig();
    pollInterval = setInterval(fetchAnalytics, 2000);
    fetchAnalytics();

    // --- Advanced UI: Particle Network Background ---
    function initParticles() {
        const canvas = document.getElementById('particle-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        let width, height;
        let particles = [];

        function resize() {
            width = canvas.width = window.innerWidth;
            height = canvas.height = window.innerHeight;
        }

        window.addEventListener('resize', resize);
        resize();

        const mouse = { x: -1000, y: -1000, radius: 150 };
        window.addEventListener('mousemove', (e) => {
            mouse.x = e.x;
            mouse.y = e.y;
        });

        class Particle {
            constructor() {
                this.x = Math.random() * width;
                this.y = Math.random() * height;
                this.vx = (Math.random() - 0.5) * 1.5;
                this.vy = (Math.random() - 0.5) * 1.5;
                this.radius = Math.random() * 2 + 1;
            }

            update() {
                this.x += this.vx;
                this.y += this.vy;

                if (this.x < 0 || this.x > width) this.vx *= -1;
                if (this.y < 0 || this.y > height) this.vy *= -1;

                // Mouse interaction (repel)
                const dx = mouse.x - this.x;
                const dy = mouse.y - this.y;
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist < mouse.radius) {
                    const force = (mouse.radius - dist) / mouse.radius;
                    this.x -= (dx / dist) * force * 2;
                    this.y -= (dy / dist) * force * 2;
                }
            }

            draw() {
                ctx.beginPath();
                ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(0, 255, 255, 0.4)';
                ctx.fill();
            }
        }

        for (let i = 0; i < 100; i++) particles.push(new Particle());

        function animate() {
            ctx.clearRect(0, 0, width, height);

            for (let i = 0; i < particles.length; i++) {
                particles[i].update();
                particles[i].draw();

                // Connect particles
                for (let j = i; j < particles.length; j++) {
                    const dx = particles[i].x - particles[j].x;
                    const dy = particles[i].y - particles[j].y;
                    const dist = Math.sqrt(dx * dx + dy * dy);

                    if (dist < 120) {
                        ctx.beginPath();
                        ctx.strokeStyle = `rgba(0, 255, 255, ${1 - dist / 120})`;
                        ctx.lineWidth = 0.5;
                        ctx.moveTo(particles[i].x, particles[i].y);
                        ctx.lineTo(particles[j].x, particles[j].y);
                        ctx.stroke();
                    }
                }
            }
            requestAnimationFrame(animate);
        }
        animate();
    }
    initParticles();


    // --- History Gallery Logic ---
    // --- History Loading & Filtering ---
    let globalHistoryData = [];
    let currentFilterSource = 'all';
    let selectedHistoryIds = new Set();

    async function fetchHistory() {
        const grid = document.getElementById('history-grid');
        const tbody = document.getElementById('history-tbody');
        if (!grid && !tbody) return;

        if (grid) grid.innerHTML = '<div class="cyber-text" style="grid-column: 1/-1; text-align: center; padding: 3rem;">RETRIVING UPLINK DATA...</div>';
        if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 2rem;">Loading history logs...</td></tr>`;

        try {
            const token = window.Clerk && window.Clerk.session ? await window.Clerk.session.getToken() : null;
            const headers = {};
            if (token) headers['Authorization'] = `Bearer ${token}`;

            const res = await fetch('/history', { headers });
            if (!res.ok) throw new Error("Failed to fetch history");

            globalHistoryData = await res.json();
            renderHistory(globalHistoryData);
        } catch (err) {
            console.error(err);
            if (grid) grid.innerHTML = `<div class="cyber-text" style="grid-column: 1/-1; text-align: center; color: red; padding: 3rem;">UPLINK ERROR: ${err.message}</div>`;
            if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: red; padding: 2rem;">Error loading history logs.</td></tr>`;
        }
    }

    function renderHistory(data) {
        const grid = document.getElementById('history-grid');
        const tbody = document.getElementById('history-tbody');

        // Populate Grid (Gallery)
        if (grid) {
            if (!data || data.length === 0) {
                grid.innerHTML = '<div class="cyber-text" style="grid-column: 1/-1; text-align: center; opacity: 0.5; padding: 3rem;">NO VISUAL ARCHIVES FOUND.</div>';
            } else {
                grid.innerHTML = '';
                data.forEach(item => {
                    if (!item.media_url) return;
                    const card = document.createElement('div');
                    card.className = 'history-card';
                    card.style.position = 'relative'; // for absolute checkbox
                    const date = new Date(item.created_at || item.timestamp).toLocaleString();
                    const objs = Object.entries(item.objects_detected || {})
                        .map(([name, count]) => `${name} (${count})`)
                        .join(', ') || 'Processing...';

                    const isChecked = selectedHistoryIds.has(item.id.toString()) ? 'checked' : '';

                    card.innerHTML = `
                        <input type="checkbox" class="history-select-checkbox" data-id="${item.id}" ${isChecked} style="position: absolute; top: 10px; right: 10px; z-index: 10; cursor: pointer; transform: scale(1.5);">
                        <img src="${item.media_url}" alt="Detection" loading="lazy">
                        <div class="card-content">
                            <div class="card-date">${date}</div>
                            <div class="card-objs">${objs}</div>
                            <div class="card-type">${(item.media_type || 'Unknown').toUpperCase()}</div>
                        </div>
                    `;
                    
                    // Click card to toggle checkbox
                    card.addEventListener('click', (e) => {
                        if(e.target.tagName.toLowerCase() !== 'input') {
                            const cb = card.querySelector('.history-select-checkbox');
                            if(cb) {
                                cb.checked = !cb.checked;
                                toggleSelection(item.id.toString(), cb.checked);
                            }
                        }
                    });
                    
                    grid.appendChild(card);
                });
            }
        }

        // Populate Table (Logs)
        if (tbody) {
            if (!data || data.length === 0) {
                tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 2rem;">No detection history recorded yet.</td></tr>`;
            } else {
                tbody.innerHTML = '';
                data.forEach(log => {
                    const tr = document.createElement('tr');
                    const date = new Date(log.created_at || log.timestamp);
                    const timeStr = isNaN(date.getTime()) ? 'Unknown Time' : date.toLocaleString();
                    let sourceStr = log.media_type || 'Unknown';
                    let objects = 'None';
                    if (log.objects_detected && typeof log.objects_detected === 'object') {
                        objects = Object.keys(log.objects_detected).join(', ');
                    }

                    let statusCol = `<span style="color: #0f0;">LOGGED</span>`;
                    if (log.media_url) {
                        statusCol = `<a href="${log.media_url}" target="_blank" style="color: var(--neon-cyan); text-decoration: underline;">View Result</a>`;
                    }

                    const isChecked = selectedHistoryIds.has(log.id.toString()) ? 'checked' : '';

                    tr.innerHTML = `
                        <td style="text-align: center;"><input type="checkbox" class="history-select-checkbox" data-id="${log.id}" ${isChecked} style="cursor: pointer;"></td>
                        <td style="color: var(--text-muted);">${timeStr}</td>
                        <td style="color: var(--neon-cyan);">${sourceStr.toUpperCase()}</td>
                        <td style="color: #fff; font-weight: bold;">[${objects.toUpperCase() || 'SEARCHING...'}]</td>
                        <td>${statusCol}</td>
                    `;
                    tbody.appendChild(tr);
                });
            }
        }
        
        attachCheckboxListeners();
        updateBulkDeleteUI();
    }

    function toggleSelection(idStr, isChecked) {
        if (isChecked) {
            selectedHistoryIds.add(idStr);
        } else {
            selectedHistoryIds.delete(idStr);
        }
        updateBulkDeleteUI();
    }

    function attachCheckboxListeners() {
        document.querySelectorAll('.history-select-checkbox').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const id = e.target.getAttribute('data-id');
                toggleSelection(id, e.target.checked);
            });
        });
    }

    function updateBulkDeleteUI() {
        const count = selectedHistoryIds.size;
        const deleteSelectedBtn = document.getElementById('delete-selected-history');
        const countSpan = document.getElementById('selected-count');
        const selectAllCb = document.getElementById('select-all-history');
        
        if (deleteSelectedBtn && countSpan) {
            if (count > 0) {
                deleteSelectedBtn.style.display = 'inline-block';
                countSpan.textContent = count;
            } else {
                deleteSelectedBtn.style.display = 'none';
            }
        }
        
        if (selectAllCb) {
            const visibleCheckboxes = document.querySelectorAll('.history-select-checkbox');
            if (visibleCheckboxes.length > 0) {
                const allChecked = Array.from(visibleCheckboxes).every(cb => cb.checked);
                selectAllCb.checked = allChecked;
            } else {
                selectAllCb.checked = false;
            }
        }
    }

    // Handle 'Select All' in table header
    const selectAllCb = document.getElementById('select-all-history');
    if (selectAllCb) {
        selectAllCb.addEventListener('change', (e) => {
            const isChecked = e.target.checked;
            document.querySelectorAll('.history-select-checkbox').forEach(cb => {
                cb.checked = isChecked;
                toggleSelection(cb.getAttribute('data-id'), isChecked);
            });
        });
    }

    let pendingDeleteId = null;
    const deleteBtn = document.getElementById('confirm-delete-btn');
    const cancelBtn = document.getElementById('cancel-delete-btn');
    const deleteModal = document.getElementById('delete-confirm-modal');

    function showDeleteModal(eventId) {
        pendingDeleteId = eventId;
        if (deleteModal) deleteModal.style.display = 'flex';
    }

    function hideDeleteModal() {
        pendingDeleteId = null;
        if (deleteModal) deleteModal.style.display = 'none';
    }

    if (cancelBtn) {
        cancelBtn.addEventListener('click', hideDeleteModal);
    }

    if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
            if (pendingDeleteId) {
                const idToDelete = pendingDeleteId;
                hideDeleteModal();
                await deleteHistoryRecord(idToDelete);
            }
        });
    }

    // Close modal if click outside
    window.addEventListener('click', (e) => {
        if (e.target === deleteModal) hideDeleteModal();
    });

    // Event Delegation for Delete Buttons in Gallery and Table
    document.addEventListener('click', (e) => {
        if (e.target && e.target.classList.contains('delete-history-btn')) {
            const eventId = e.target.getAttribute('data-id');
            showDeleteModal(eventId);
        }
    });

    async function deleteHistoryRecord(eventId) {
        // Ensure we clear selection for the deleted items
        selectedHistoryIds.delete(eventId.toString());
        updateBulkDeleteUI();
        
        try {
            const token = window.Clerk && Clerk.session ? await Clerk.session.getToken() : null;
            const headers = {};
            if (token) headers['Authorization'] = `Bearer ${token}`;

            const res = await fetch(`/history/${eventId}`, {
                method: 'DELETE',
                headers: headers
            });

            if (res.ok) {
                // Remove from global list and re-render without refetching from server immediately (optimistic update)
                globalHistoryData = globalHistoryData.filter(item => item.id.toString() !== eventId.toString());
                const searchInput = document.getElementById('history-search-input');
                if (searchInput && searchInput.value) {
                    filterHistory(searchInput.value);
                } else {
                    renderHistory(globalHistoryData);
                }
                if(window.fireAlert) window.fireAlert("Record deleted successfully.");
            } else {
                const data = await res.json();
                if(window.fireAlert) window.fireAlert('Failed to delete: ' + (data.error || 'Server error'));
                else console.error('Failed to delete: ' + (data.error || 'Server error'));
            }
        } catch (err) {
            console.error(err);
            if(window.fireAlert) window.fireAlert("Error deleting record. Network issue.");
        }
    }

    function filterHistory(query) {
        let filtered = globalHistoryData;
        
        // Apply Source Filter First
        if (currentFilterSource !== 'all') {
            filtered = filtered.filter(item => {
                const src = (item.media_type || '').toLowerCase();
                if (currentFilterSource === 'webcam') return src === 'webcam';
                if (currentFilterSource === 'surveillance') return src.includes('surveillance');
                if (currentFilterSource === 'media') return ['image', 'video'].includes(src);
                return true;
            });
        }
        
        // Then Apply Search Query
        if (query) {
            const lowerQ = query.toLowerCase();
            filtered = filtered.filter(item => {
                const dateStr = new Date(item.created_at || item.timestamp).toLocaleString().toLowerCase();
                const sourceStr = (item.media_type || '').toLowerCase();
                const objsStr = Object.keys(item.objects_detected || {}).join(' ').toLowerCase();
                return dateStr.includes(lowerQ) || sourceStr.includes(lowerQ) || objsStr.includes(lowerQ);
            });
        }
        renderHistory(filtered);
    }

    const searchInput = document.getElementById('history-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            filterHistory(e.target.value);
        });
    }

    // Attach functionality to Filter/Source Buttons
    const filterBtns = document.querySelectorAll('.filter-btn');
    if (filterBtns) {
        filterBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                // Update Button Active States
                filterBtns.forEach(b => {
                    b.classList.remove('btn-primary');
                    b.classList.add('btn-outline');
                });
                e.target.classList.remove('btn-outline');
                e.target.classList.add('btn-primary');
                
                currentFilterSource = e.target.getAttribute('data-filter');
                filterHistory(searchInput ? searchInput.value : '');
            });
        });
    }

    // Initialize History Refresh
    const refreshBtn = document.getElementById('refresh-history');
    if (refreshBtn) refreshBtn.addEventListener('click', fetchHistory);

    // Initialize Clear All History
    const clearAllBtn = document.getElementById('clear-all-history');
    if (clearAllBtn) {
        clearAllBtn.addEventListener('click', async () => {
            if (globalHistoryData.length === 0) {
                if (window.fireAlert) window.fireAlert("History is already empty.");
                return;
            }

            if (confirm("WARNING: This will permanently delete ALL your detection history. This action cannot be undone. Are you sure?")) {
                try {
                    clearAllBtn.innerHTML = 'Clearing...';
                    clearAllBtn.disabled = true;

                    const token = window.Clerk && Clerk.session ? await Clerk.session.getToken() : null;
                    const headers = {};
                    if (token) headers['Authorization'] = `Bearer ${token}`;

                    const res = await fetch('/history/all', {
                        method: 'DELETE',
                        headers: headers
                    });

                    if (res.ok) {
                        globalHistoryData = [];
                        selectedHistoryIds.clear();
                        renderHistory([]);
                        if (window.fireAlert) window.fireAlert("All history cleared successfully.");
                    } else {
                        const data = await res.json();
                        if (window.fireAlert) window.fireAlert("Failed to clear history: " + (data.error || "Server Error"));
                    }
                } catch (err) {
                    console.error(err);
                    if (window.fireAlert) window.fireAlert("Network error while clearing history.");
                } finally {
                    clearAllBtn.innerHTML = 'Clear All';
                    clearAllBtn.disabled = false;
                }
            }
        });
    }

    // Initialize Bulk Delete Action
    const deleteSelectedBtn = document.getElementById('delete-selected-history');
    if (deleteSelectedBtn) {
        deleteSelectedBtn.addEventListener('click', async () => {
            const count = selectedHistoryIds.size;
            if (count === 0) return;

            if (confirm(`Are you sure you want to delete the ${count} selected record(s)?`)) {
                try {
                    deleteSelectedBtn.innerHTML = 'Deleting...';
                    deleteSelectedBtn.disabled = true;

                    const token = window.Clerk && Clerk.session ? await Clerk.session.getToken() : null;
                    const headers = { 'Content-Type': 'application/json' };
                    if (token) headers['Authorization'] = `Bearer ${token}`;

                    const idsArray = Array.from(selectedHistoryIds);

                    const res = await fetch('/history/bulk', {
                        method: 'DELETE',
                        headers: headers,
                        body: JSON.stringify({ event_ids: idsArray })
                    });

                    if (res.ok) {
                        // Optimistic update
                        globalHistoryData = globalHistoryData.filter(item => !selectedHistoryIds.has(item.id.toString()));
                        selectedHistoryIds.clear();
                        
                        const searchInput = document.getElementById('history-search-input');
                        if (searchInput && searchInput.value) {
                            filterHistory(searchInput.value);
                        } else {
                            renderHistory(globalHistoryData);
                        }
                        
                        if (window.fireAlert) window.fireAlert(`Successfully deleted ${count} record(s).`);
                    } else {
                        const data = await res.json();
                        if (window.fireAlert) window.fireAlert("Failed to delete records: " + (data.error || "Server Error"));
                    }
                } catch (err) {
                    console.error(err);
                    if (window.fireAlert) window.fireAlert("Network error while deleting records.");
                } finally {
                    deleteSelectedBtn.disabled = false;
                    updateBulkDeleteUI();
                }
            }
        });
    }

    // Load history when the history tab is clicked
    document.querySelectorAll('.nav-btn[data-target="history"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            fetchHistory();
        });
    });

    // --- Surveillance Command Center Logic ---
    const surveillanceModal = document.getElementById('assign-modal');
    const closeSurvModal = document.querySelector('.close-modal');
    const assignBtns = document.querySelectorAll('.assign-btn');
    const modalFeedIdSpan = document.getElementById('modal-feed-id');
    const modalBtnWebcam = document.getElementById('modal-btn-webcam');
    const modalVideoForm = document.getElementById('modal-video-form');
    const modalVideoInput = document.getElementById('modal-video-input');
    const surveillanceLogs = document.getElementById('surveillance-logs');

    const addMonitorBtn = document.getElementById('add-monitor-btn');
    const dynamicMonitorGrid = document.getElementById('dynamic-monitor-grid');

    let activeAssignFeed = null;
    let monitorCount = 0;

    // Dynamic monitor registry
    const monitors = {};

    if (surveillanceModal) {
        // Close Modal
        closeSurvModal.addEventListener('click', () => {
            surveillanceModal.style.display = 'none';
        });

        window.addEventListener('click', (e) => {
            if (e.target === surveillanceModal) surveillanceModal.style.display = 'none';
        });

        // Option 1: Live Webcam
        modalBtnWebcam.addEventListener('click', async () => {
            if (!activeAssignFeed) return;
            surveillanceModal.style.display = 'none';
            await startMonitorWebcam(activeAssignFeed);
        });

        // Option 2: Video File
        modalVideoForm.addEventListener('submit', (e) => {
            e.preventDefault();
            if (!activeAssignFeed || !modalVideoInput.files.length) return;
            surveillanceModal.style.display = 'none';

            const file = modalVideoInput.files[0];
            startMonitorVideo(activeAssignFeed, file);
        });
    }

    // Function to dynamically add a new monitor to the grid
    function addMonitor(isFirst = false) {
        if (Object.keys(monitors).length >= 150) {
            alert('Maximum capacity of 150 cameras reached.');
            return;
        }

        let camName = `CAM ${monitorCount + 1}`;
        if (!isFirst) {
            const inputName = prompt("Enter Camera Name/Location:", camName);
            if (!inputName) return; // User cancelled
            camName = inputName.substring(0, 30).toUpperCase(); // Limit length and uppercase
        }

        monitorCount++;
        const feedId = monitorCount;

        // Initialize state
        monitors[feedId] = { stream: null, interval: null, processing: false, name: camName };

        // Create HTML structure
        const monitorDiv = document.createElement('div');
        monitorDiv.className = 'monitor-feed glow-card';
        monitorDiv.innerHTML = `
            <div class="monitor-header">
                <span class="monitor-id">${camName} : UNASSIGNED</span>
                <span class="status-dot"></span>
            </div>
            <div class="video-container" id="feed-${feedId}-container">
                <div class="placeholder-overlay">AWAITING FEED...</div>
                <video id="feed-${feedId}-video" autoplay playsinline style="display:none;"></video>
                <img id="feed-${feedId}-result" src="" style="display:none;">
                <canvas id="feed-${feedId}-canvas" style="display:none;"></canvas>
            </div>
            <div class="monitor-controls">
                <button class="btn btn-outline btn-sm assign-btn" data-feed="${feedId}">Assign Source</button>
                <button class="btn btn-danger btn-sm remove-btn" data-feed="${feedId}" style="margin-left: 10px; border-color: red; color: red;">Remove</button>
            </div>
        `;

        dynamicMonitorGrid.appendChild(monitorDiv);

        // Attach Assign Button Listener
        const assignBtn = monitorDiv.querySelector('.assign-btn');
        assignBtn.addEventListener('click', () => {
            activeAssignFeed = feedId;
            modalFeedIdSpan.textContent = monitors[feedId].name;
            surveillanceModal.style.display = 'flex';
        });

        // Attach Remove Button Listener
        const removeBtn = monitorDiv.querySelector('.remove-btn');
        removeBtn.addEventListener('click', () => {
            cleanupMonitor(feedId);
            delete monitors[feedId];
            monitorDiv.remove();
        });
    }

    if (addMonitorBtn) {
        addMonitorBtn.addEventListener('click', () => {
            addMonitor();
        });

        // Add one default monitor to start without prompting
        addMonitor(true);
    }

    function cleanupMonitor(feedId) {
        const mon = monitors[feedId];
        if (mon.interval) { clearInterval(mon.interval); mon.interval = null; }
        if (mon.stream) { mon.stream.getTracks().forEach(t => t.stop()); mon.stream = null; }

        const video = document.getElementById(`feed-${feedId}-video`);
        const result = document.getElementById(`feed-${feedId}-result`);
        const overlay = document.querySelector(`#feed-${feedId}-container .placeholder-overlay`);
        const dot = document.querySelector(`#feed-${feedId}-container`).parentElement.querySelector('.status-dot');
        const btn = document.querySelector(`.assign-btn[data-feed="${feedId}"]`);

        if (video) { video.srcObject = null; video.src = ''; video.style.display = 'none'; }
        if (result) { result.src = ''; result.style.display = 'none'; }
        if (overlay) { overlay.textContent = 'OFFLINE'; overlay.style.display = 'block'; }
        if (dot) dot.classList.remove('active');
        if (btn) btn.textContent = 'Assign Source';
    }

    async function startMonitorWebcam(feedId) {
        cleanupMonitor(feedId);
        const video = document.getElementById(`feed-${feedId}-video`);
        const overlay = document.querySelector(`#feed-${feedId}-container .placeholder-overlay`);
        const dot = document.querySelector(`#feed-${feedId}-container`).parentElement.querySelector('.status-dot');
        const btn = document.querySelector(`.assign-btn[data-feed="${feedId}"]`);

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
            monitors[feedId].stream = stream;
            video.srcObject = stream;
            video.style.display = 'block';
            overlay.style.display = 'none';
            dot.classList.add('active');
            btn.textContent = 'Stop Feed';

            // Re-assign click to stop
            btn.onclick = (e) => {
                e.preventDefault();
                cleanupMonitor(feedId);
                btn.onclick = null; // reset to open modal via standard listener
            };

            logIncident(`[${monitors[feedId].name}] Live uplink established.`, 'system');

            // Start ML processing loop (fast polling, constrained by mon.processing lock)
            monitors[feedId].interval = setInterval(() => processMonitorFrame(feedId), 100);

        } catch (err) {
            console.error(err);
            alert("Could not access camera: " + err.message);
            cleanupMonitor(feedId);
        }
    }

    function startMonitorVideo(feedId, file) {
        cleanupMonitor(feedId);
        const video = document.getElementById(`feed-${feedId}-video`);
        const overlay = document.querySelector(`#feed-${feedId}-container .placeholder-overlay`);
        const dot = document.querySelector(`#feed-${feedId}-container`).parentElement.querySelector('.status-dot');
        const btn = document.querySelector(`.assign-btn[data-feed="${feedId}"]`);

        const url = URL.createObjectURL(file);
        video.src = url;
        video.loop = true;
        video.muted = true;
        video.play();

        video.style.display = 'block';
        overlay.style.display = 'none';
        dot.classList.add('active');
        btn.textContent = 'Stop Feed';

        btn.onclick = (e) => {
            e.preventDefault();
            URL.revokeObjectURL(url);
            cleanupMonitor(feedId);
            btn.onclick = null;
        };

        logIncident(`[${monitors[feedId].name}] Processing local video archive.`, 'system');

        // Start ML processing loop
        monitors[feedId].interval = setInterval(() => processMonitorFrame(feedId), 100);
    }

    async function processMonitorFrame(feedId) {
        const mon = monitors[feedId];
        if (mon.processing) return; // Prevent overlapping requests

        const video = document.getElementById(`feed-${feedId}-video`);
        const canvas = document.getElementById(`feed-${feedId}-canvas`);
        const resultImg = document.getElementById(`feed-${feedId}-result`);

        if (!video || !canvas || video.paused || video.ended || !video.videoWidth) return;

        mon.processing = true;

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // Compress
        const smallCanvas = document.createElement('canvas');
        smallCanvas.width = 640;
        smallCanvas.height = Math.round(canvas.height * 640 / canvas.width);
        const sCtx = smallCanvas.getContext('2d');
        sCtx.drawImage(canvas, 0, 0, smallCanvas.width, smallCanvas.height);
        const base64Data = smallCanvas.toDataURL('image/jpeg', 0.8);

        try {
            const token = window.Clerk && window.Clerk.session ? await window.Clerk.session.getToken() : null;
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers['Authorization'] = `Bearer ${token}`;

            const response = await fetch('/process_webcam_frame', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ image: base64Data })
            });

            if (response.ok) {
                const data = await response.json();
                if (data.image) {
                    video.style.display = 'none';
                    resultImg.style.display = 'block';
                    resultImg.src = `data:image/jpeg;base64,${data.image}`;

                    // Log real detections from the backend
                    if (data.detections && data.detections.length > 0) {
                        const activeAlerts = Array.from(document.querySelectorAll('#target-alert-pills input:checked')).map(cb => cb.value.toLowerCase());

                        data.detections.forEach(threat => {
                            // Don't spam the exact same threat from the same camera too quickly (3 seconds)
                            if (mon.lastThreat === threat && (Date.now() - mon.lastThreatTime < 3000)) return;

                            let type = 'system';
                            if (['person'].includes(threat)) type = 'person';
                            if (['car', 'truck', 'bus', 'motorcycle', 'bicycle'].includes(threat)) type = 'vehicle';
                            if (['knife', 'gun', 'backpack', 'suitcase'].includes(threat)) type = 'threat';

                            logIncident(`CAM ${feedId}: Detected [${threat.toUpperCase()}] in sector.`, type);

                            // Check against User's Active Target Alerts
                            if (activeAlerts.includes(threat.toLowerCase())) {
                                window.fireAlert(`${threat.toUpperCase()} observed on CAM ${feedId}`);
                                // Write to DB History Log
                                if (typeof window.logDetectionEvent === 'function') {
                                    window.logDetectionEvent(`Surveillance CAM ${feedId}`, [threat], data.image);
                                }
                            }

                            mon.lastThreat = threat;
                            mon.lastThreatTime = Date.now();
                        });
                    }
                }
            } else if (response.status === 401) {
                cleanupMonitor(feedId);
                alert("Please sign in to access surveillance feeds.");
            }
        } catch (err) {
            console.error(`Feed ${feedId} error:`, err);
        } finally {
            mon.processing = false;
        }
    }

    function logIncident(message, type) {
        if (!surveillanceLogs) return;
        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;

        const now = new Date();
        const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

        entry.innerHTML = `<span class="time">[${timeStr}]</span><span class="msg">${message}</span>`;
        surveillanceLogs.insertBefore(entry, surveillanceLogs.firstChild);

        // Keep max 50 entries
        if (surveillanceLogs.children.length > 50) {
            surveillanceLogs.removeChild(surveillanceLogs.lastChild);
        }
    }

    // --- Alert Toast System ---
    let lastAlertSoundTime = 0;
    const alertAudio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3'); // Simple beep
    alertAudio.volume = 0.5;

    window.fireAlert = function (message) {
        const container = document.getElementById('toast-container');
        if (!container) return;

        // Debounce sound
        const now = Date.now();
        if (now - lastAlertSoundTime > 2000) {
            alertAudio.play().catch(e => console.log("Audio play blocked by browser."));
            lastAlertSoundTime = now;
        }

        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = `ALERT: ${message}`;
        container.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => toast.remove(), 300);
        }, 5000);
    };

    // --- Detection History & Logging ---
    window.logDetectionEvent = async function (sourceName, detectedObjects, imageB64 = null) {
        if (!detectedObjects || detectedObjects.length === 0) return;

        try {
            const token = window.Clerk && Clerk.session ? await Clerk.session.getToken() : null;
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers['Authorization'] = `Bearer ${token}`;

            const payload = {
                source: sourceName,
                objects: detectedObjects
            };
            if (imageB64) {
                payload.image = imageB64;
            }

            await fetch('/log_event', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(payload)
            });
        } catch (e) {
            console.error("Failed to log event:", e);
        }
    };

    const historyBtn = document.querySelector('.nav-btn[data-target="history"]');
    if (historyBtn) {
        historyBtn.addEventListener('click', () => {
            fetchHistory();
        });
    }

    const refreshHistoryGridBtn = document.getElementById('refresh-history');
    if (refreshHistoryGridBtn) {
        refreshHistoryGridBtn.addEventListener('click', fetchHistory);
    }

    const refreshHistoryTbodyBtn = document.getElementById('refresh-history-btn');
    if (refreshHistoryTbodyBtn) {
        refreshHistoryTbodyBtn.addEventListener('click', fetchHistory);
    }

    // Initial load
    fetchHistory();
});
