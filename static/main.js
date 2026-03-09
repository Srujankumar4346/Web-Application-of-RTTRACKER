import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyD_0sFroCFz0zzbeGdQ4A-2-boBHN3jUt8",
    authDomain: "rttracker-8bb39.firebaseapp.com",
    projectId: "rttracker-8bb39",
    storageBucket: "rttracker-8bb39.firebasestorage.app",
    messagingSenderId: "531381957306",
    appId: "1:531381957306:web:380085c504a171f68f0883",
    measurementId: "G-GV3PT4RPMQ"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

document.addEventListener('DOMContentLoaded', () => {

    // --- Navigation logic for Single Page App ---
    const navBtns = document.querySelectorAll('.nav-btn');
    const sections = document.querySelectorAll('.page-section');

    // Auth Elements
    const loginModal = document.getElementById('auth-modal');
    const loginForm = document.getElementById('login-form');
    const loginError = document.getElementById('login-error');
    const logoutContainer = document.getElementById('logout-container');
    const logoutBtn = document.getElementById('logout-btn');
    const adminPanel = document.getElementById('admin-panel');

    let currentUserRole = null;
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
        resultDisplay.src = src;
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
            document.getElementById('img-file-name').textContent = this.files[0] ? this.files[0].name : '';
        });
    }

    const vidInput = document.getElementById('video-input');
    if (vidInput) {
        vidInput.addEventListener('change', function () {
            document.getElementById('vid-file-name').textContent = this.files[0] ? this.files[0].name : '';
        });
    }

    // --- Image Upload ---
    const imgForm = document.getElementById('image-upload-form');
    if (imgForm) {
        imgForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const fileInput = document.getElementById('image-input');
            if (!fileInput.files.length) return alert('Please select an image first.');

            showLoading();

            const formData = new FormData();
            formData.append('image', fileInput.files[0]);

            try {
                const response = await fetch('/upload_image', {
                    method: 'POST',
                    body: formData
                });
                const data = await response.json();

                if (data.error) {
                    alert(data.error);
                    resetDisplay();
                    return;
                }

                showResult(`data:image/jpeg;base64,${data.image}`);
            } catch (err) {
                console.error(err);
                alert('Error connecting to tracking server.');
                resetDisplay();
            }
        });
    }

    // --- Video Upload ---
    const vidForm = document.getElementById('video-upload-form');
    if (vidForm) {
        vidForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const fileInput = document.getElementById('video-input');
            if (!fileInput.files.length) return alert('Please select a video file.');

            showLoading();

            const formData = new FormData();
            formData.append('video', fileInput.files[0]);

            try {
                const response = await fetch('/upload_video', {
                    method: 'POST',
                    body: formData
                });
                const data = await response.json();

                if (data.error) {
                    alert(data.error);
                    resetDisplay();
                    return;
                }

                // Set the src to the video stream returned by API
                showResult(data.video_url);
            } catch (err) {
                console.error(err);
                alert('Error uploading and processing video.');
                resetDisplay();
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

    // --- Auth & Admin Logic ---
    function checkSession() {
        console.log("Checking session...");
        fetch('/user_status')
            .then(r => r.json())
            .then(data => {
                if (data.logged_in) {
                    loginModal.style.display = 'none';
                    logoutContainer.style.display = 'inline-block';
                    currentUserRole = data.role;
                    if (currentUserRole === 'admin') {
                        adminPanel.style.display = 'block';
                        fetchAdminConfig();
                    } else {
                        adminPanel.style.display = 'none';
                    }
                    if (!pollInterval) {
                        pollInterval = setInterval(fetchAnalytics, 2000);
                        fetchAnalytics();
                    }
                } else {
                    loginModal.style.display = 'flex';
                    logoutContainer.style.display = 'none';
                    adminPanel.style.display = 'none';
                    if (pollInterval) {
                        clearInterval(pollInterval);
                        pollInterval = null;
                    }
                }
            }).catch(e => console.error(e));
    }

    let isSignUpMode = false;
    const toggleAuthModeBtn = document.getElementById('toggle-auth-mode');
    const authTitle = document.getElementById('auth-title');
    const authSubmitBtn = document.getElementById('auth-submit-btn');

    toggleAuthModeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        isSignUpMode = !isSignUpMode;
        if (isSignUpMode) {
            authTitle.textContent = "REGISTER_NODE";
            authSubmitBtn.textContent = "INITIALIZE NODE (REGISTER)";
            toggleAuthModeBtn.textContent = "ALREADY SECURED? AUTHENTICATE (LOGIN)";
        } else {
            authTitle.textContent = "SYSTEM_AUTH";
            authSubmitBtn.textContent = "AUTHENTICATE";
            toggleAuthModeBtn.textContent = "NEW USER? INITIALIZE A NODE (SIGN UP)";
        }
    });

    loginForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const email = document.getElementById('username').value;
        const password = document.getElementById('password').value;

        authSubmitBtn.textContent = "PROCESSING...";
        authSubmitBtn.disabled = true;

        if (isSignUpMode) {
            createUserWithEmailAndPassword(auth, email, password)
                .then((userCredential) => userCredential.user.getIdToken())
                .then(idToken => sendTokenToBackend(idToken))
                .catch(err => {
                    loginError.textContent = err.message;
                    loginError.style.display = 'block';
                    authSubmitBtn.textContent = "INITIALIZE NODE (REGISTER)";
                    authSubmitBtn.disabled = false;
                });
        } else {
            signInWithEmailAndPassword(auth, email, password)
                .then((userCredential) => userCredential.user.getIdToken())
                .then(idToken => sendTokenToBackend(idToken))
                .catch(err => {
                    loginError.textContent = "Access Denied: " + err.message;
                    loginError.style.display = 'block';
                    authSubmitBtn.textContent = "AUTHENTICATE";
                    authSubmitBtn.disabled = false;
                });
        }
    });

    function sendTokenToBackend(idToken) {
        fetch('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken: idToken })
        }).then(r => r.json()).then(data => {
            if (data.success) {
                loginError.style.display = 'none';
                loginForm.reset();
                authSubmitBtn.disabled = false;
                checkSession();
            } else {
                loginError.textContent = "Server Trust Failed: " + data.message;
                loginError.style.display = 'block';
                authSubmitBtn.textContent = isSignUpMode ? "INITIALIZE NODE (REGISTER)" : "AUTHENTICATE";
                authSubmitBtn.disabled = false;
            }
        });
    }

    logoutBtn.addEventListener('click', (e) => {
        e.preventDefault();
        signOut(auth).then(() => {
            fetch('/logout', { method: 'POST' }).then(() => checkSession());
        });
    });

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

    // Start App by checking login
    checkSession();
});
