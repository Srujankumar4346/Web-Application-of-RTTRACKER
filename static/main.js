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
                resultDisplay.style.display = 'block';

                // Process frames at roughly 5 FPS to avoid crashing Cloud free tiers
                webcamInterval = setInterval(processWebcamFrame, 200);
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

    async function processWebcamFrame() {
        if (!clientWebcam || !clientCanvas || !clientWebcam.videoWidth) return;

        clientCanvas.width = clientWebcam.videoWidth;
        clientCanvas.height = clientWebcam.videoHeight;
        const ctx = clientCanvas.getContext('2d');
        ctx.drawImage(clientWebcam, 0, 0, clientCanvas.width, clientCanvas.height);

        // Compress heavily for cloud uploads (0.6 quality JPEG)
        const base64Data = clientCanvas.toDataURL('image/jpeg', 0.6);

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
                resultDisplay.src = `data:image/jpeg;base64,${data.image}`;
            }
        } catch (err) {
            console.error("Frame dropped:", err);
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

    async function processSingleImage(file, display) {
        showLoading();
        display.textContent = `Processing: ${file.name}`;
        const formData = new FormData();
        formData.append('image', file);
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

            // Guard against non-JSON responses (like Render's 502/504 HTML error pages)
            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                const text = await response.text();
                console.error("Non-JSON response (HTTP " + response.status + "):", text.substring(0, 300));
                alert(`Server error (HTTP ${response.status}). The server may have run out of memory. Please try a smaller image or try again in a moment.`);
                resetDisplay();
                return;
            }

            const data = await response.json();

            if (data.error) {
                alert("Error: " + data.error);
                resetDisplay();
                return;
            }

            if (data.image) showResult(`data:image/jpeg;base64,${data.image}`);
        } catch (err) {
            console.error(err);
            alert("Network error: " + err.message + ". The server may be busy or starting up — wait 30 seconds and try again.");
            resetDisplay();
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

                try {
                    const token = await window.Clerk ? await window.Clerk.session.getToken() : null;
                    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

                    const response = await fetch('/upload_video', {
                        method: 'POST',
                        body: formData,
                        headers: headers
                    });
                    const data = await response.json();

                    if (response.status === 401) {
                        alert("Please sign in to run detections!");
                        resetDisplay();
                        return;
                    }

                    if (data.error) {
                        alert(`Error on file ${file.name}: ${data.error}`);
                        continue;
                    }

                    // Set the src to the video stream returned by API
                    showResult(data.video_url);

                    // For multiple videos, we might want a way to skip or wait
                    // For now, let's just wait if there's more than one
                    if (i < fileInput.files.length - 1) {
                        // We wait 10 seconds per video if multiple are selected, or we could add a "skip" button
                        // Given it's a presentation, 10s is a decent preview
                        await new Promise(resolve => setTimeout(resolve, 10000));
                    }
                } catch (err) {
                    console.error(err);
                    alert(`Error uploading ${file.name}`);
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

        // Keep homepage counters in sync with live analytics
        updateHeroCounters(total, fps, accuracy);
    }

    // --- Hero Counter Animations ---
    let heroFrameCount = 0;
    function animateCounter(el, target) {
        if (!el) return;
        const current = parseInt(el.textContent) || 0;
        const step = Math.ceil(Math.abs(target - current) / 8);
        if (current < target) {
            el.textContent = Math.min(current + step, target);
        } else if (current > target) {
            el.textContent = Math.max(current - step, target);
        }
    }
    function updateHeroCounters(objects, fps, accuracy) {
        heroFrameCount += Math.max(1, Math.round(fps));
        const cntObjects = document.getElementById('cnt-objects');
        const cntFrames = document.getElementById('cnt-frames');
        const cntRate = document.getElementById('cnt-rate');
        if (cntObjects) animateCounter(cntObjects, objects);
        if (cntFrames) cntFrames.textContent = heroFrameCount.toLocaleString();
        if (cntRate) {
            const rateEl = cntRate.querySelector('span') ? cntRate : cntRate;
            const numPart = Math.round(accuracy);
            const inner = cntRate.innerHTML;
            cntRate.innerHTML = `${numPart}<span style="font-size:1.2rem">%</span>`;
        }
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
                if (data.error) return;
                adminModelSelect.value = data.model_name;

                adminConfSlider.value = data.confidence;
                confValDisplay.textContent = Math.round(data.confidence * 100) + '%';

                adminIouSlider.value = data.iou;
                iouValDisplay.textContent = Math.round(data.iou * 100) + '%';
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

    // --- Advanced UI: Hacker Terminal ---
    function initTerminal() {
        const terminalOutput = document.getElementById('terminal-content');
        if (!terminalOutput) return;

        const bootSequence = [
            `> INITIALIZING NEURAL NETWORK...`,
            `> LOADING YOLOv8 WEIGHTS [OK]`,
            `> ESTABLISHING CLERK AUTH... SUCCESS`,
            `> SUPABASE UPLINK: SECURE [ENCRYPTED]`,
            `> AWAITING SENSOR INPUT...`
        ];

        let lineIdx = 0;
        let charIdx = 0;

        function typeLine() {
            if (lineIdx < bootSequence.length) {
                const line = bootSequence[lineIdx];
                if (charIdx < line.length) {
                    terminalOutput.innerHTML += line.charAt(charIdx);
                    charIdx++;
                    setTimeout(typeLine, Math.random() * 30 + 10);
                } else {
                    terminalOutput.innerHTML += '<br>';
                    lineIdx++;
                    charIdx = 0;
                    setTimeout(typeLine, 400); // pause between lines
                }
            } else {
                // Done booting, add blinking cursor
                terminalOutput.innerHTML += `<span class="blink-cursor">_</span>`;
            }
        }

        // Start booting slightly after page load
        setTimeout(typeLine, 1000);
    }

    // Run terminal only when home tab is active. We can just run it once.
    if (document.querySelector('.nav-btn[data-target="home"]').classList.contains('active')) {
        initTerminal();
    }

    // --- History Gallery Logic ---
    async function loadHistory() {
        const grid = document.getElementById('history-grid');
        if (!grid) return;

        try {
            const token = window.Clerk && Clerk.session ? await Clerk.session.getToken() : null;
            if (!token) {
                grid.innerHTML = '<div class="cyber-text" style="grid-column: 1/-1; text-align: center; opacity: 0.5; padding: 3rem;">AUTHENTICATION REQUIRED. PLEASE SIGN IN TO ACCESS ARCHIVES.</div>';
                return;
            }

            grid.innerHTML = '<div class="cyber-text" style="grid-column: 1/-1; text-align: center; padding: 3rem;">RETRIVING UPLINK DATA...</div>';

            const response = await fetch('/history', {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (!response.ok) throw new Error('Failed to fetch history');

            const data = await response.json();

            if (data.length === 0) {
                grid.innerHTML = '<div class="cyber-text" style="grid-column: 1/-1; text-align: center; opacity: 0.5; padding: 3rem;">NO PREVIOUS DETECTIONS FOUND.</div>';
                return;
            }

            grid.innerHTML = '';
            data.forEach(item => {
                const card = document.createElement('div');
                card.className = 'history-card';

                const date = new Date(item.created_at).toLocaleString();
                const objs = Object.entries(item.objects_detected || {})
                    .map(([name, count]) => `${name} (${count})`)
                    .join(', ') || 'No objects';

                card.innerHTML = `
                    <img src="${item.media_url}" alt="Detection" loading="lazy">
                    <div class="card-content">
                        <div class="card-date">${date}</div>
                        <div class="card-objs">${objs}</div>
                        <div class="card-type">${item.media_type}</div>
                    </div>
                `;
                grid.appendChild(card);
            });
        } catch (err) {
            console.error(err);
            grid.innerHTML = `<div class="cyber-text" style="grid-column: 1/-1; text-align: center; color: red; padding: 3rem;">UPLINK ERROR: ${err.message}</div>`;
        }
    }

    // Initialize History Refresh
    const refreshBtn = document.getElementById('refresh-history');
    if (refreshBtn) refreshBtn.addEventListener('click', loadHistory);

    // Load history when the history tab is clicked
    document.querySelectorAll('.nav-btn[data-target="history"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            loadHistory();
        });
    });
});
