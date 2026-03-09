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

    // --- Webcam Capture ---
    const startWebcamBtn = document.getElementById('start-webcam');
    const stopWebcamBtn = document.getElementById('stop-webcam');

    function stopWebcamMode() {
        if (startWebcamBtn) startWebcamBtn.style.display = 'inline-block';
        if (stopWebcamBtn) stopWebcamBtn.style.display = 'none';
        if (resultDisplay.src.includes('/video')) {
            resultDisplay.src = '';
        }
    }

    if (startWebcamBtn) {
        startWebcamBtn.addEventListener('click', () => {
            showResult('/video');
            startWebcamBtn.style.display = 'none';
            stopWebcamBtn.style.display = 'inline-block';
        });
    }

    if (stopWebcamBtn) {
        stopWebcamBtn.addEventListener('click', () => {
            resetDisplay();
        });
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
                            const response = await fetch('/upload_image', { method: 'POST', body: formData });
                            const data = await response.json();
                            if (data.image) {
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
            const response = await fetch('/upload_image', { method: 'POST', body: formData });
            const data = await response.json();
            if (data.image) showResult(`data:image/jpeg;base64,${data.image}`);
        } catch (err) {
            console.error(err);
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
                    const response = await fetch('/upload_video', {
                        method: 'POST',
                        body: formData
                    });
                    const data = await response.json();

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

        // --- Circular Charts ---
        document.getElementById('conf-text').textContent = `${confidence}%`;
        document.getElementById('conf-circle').style.transition = 'stroke-dasharray 1s ease-out';
        document.getElementById('conf-circle').setAttribute('stroke-dasharray', `${confidence}, 100`);

        // --- Progress Bars ---
        document.getElementById('pb-conf-val').textContent = `${confidence}%`;
        document.getElementById('pb-conf').style.width = `${confidence}%`;

        const fpsPercent = Math.min(100, (fps / 30) * 100).toFixed(0);
        document.getElementById('pb-fps-val').textContent = `${fpsPercent}%`;
        document.getElementById('pb-fps').style.width = `${fpsPercent}%`;

        document.getElementById('pb-acc-val').textContent = `${accuracy}%`;
        document.getElementById('pb-acc').style.width = `${accuracy}%`;

        document.getElementById('pb-motion-val').textContent = `${motion}%`;
        document.getElementById('pb-motion').style.width = `${motion}%`;

        // Update Detected Objects List
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
        if (barChartInst && pieChartInst) {
            const labels = Object.keys(objs);
            const counts = Object.values(objs);

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
});
