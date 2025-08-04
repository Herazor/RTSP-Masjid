import React, { useState, useEffect, useRef } from 'react';

const MosquePrayerDisplay = () => {
  const [currentTime, setCurrentTime] = useState(new Date());
  const [jamaahCount, setJamaahCount] = useState(0);
  const [detectionStats, setDetectionStats] = useState({
    processTime: 0,
    isDetecting: false,
    fps: 0
  });
  
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const detectorRef = useRef(null);
  const modelRef = useRef(null);
  const detectionIntervalRef = useRef(null);
  const frameCountRef = useRef(0);
  const lastFpsTimeRef = useRef(Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Load AI Model
  useEffect(() => {
    const loadModel = async () => {
      try {
        // Load TensorFlow.js and COCO-SSD
        if (window.tf && window.cocoSsd) {
          modelRef.current = await window.cocoSsd.load();
          console.log('✅ COCO-SSD model loaded');
        } else {
          // Load scripts if not already loaded
          await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@latest');
          await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@latest');
          modelRef.current = await window.cocoSsd.load();
          console.log('✅ COCO-SSD model loaded with scripts');
        }
      } catch (error) {
        console.error('Failed to load model:', error);
      }
    };

    loadModel();

    return () => {
      if (detectionIntervalRef.current) {
        clearInterval(detectionIntervalRef.current);
      }
    };
  }, []);

  // Load HLS.js dynamically and setup stream
  useEffect(() => {
    const loadHlsAndSetupStream = async () => { 
      const video = videoRef.current;
      const hlsUrl = 'http://192.168.2.129:3000/stream.m3u8';

      if (!video) return;

      try {
        // Load HLS.js from CDN if not already loaded
        if (!window.Hls) {
          await loadScript('https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.4.12/hls.min.js');
        }

        const Hls = window.Hls;

        if (Hls.isSupported()) {
          const hls = new Hls();
          hls.loadSource(hlsUrl);
          hls.attachMedia(video);

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            video
              .play()
              .then(() => {
                console.log("Video playing...");
                setupCanvas();
                startDetection();
              })
              .catch(err => console.warn("Autoplay prevented:", err));
          });

          hls.on(Hls.Events.ERROR, (event, data) => {
            console.error('HLS.js error:', data);
          });

          // Store hls instance for cleanup
          videoRef.current.hlsInstance = hls;

        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = hlsUrl;
          video.addEventListener('loadedmetadata', () => {
            video
              .play()
              .then(() => {
                console.log("Native HLS playing");
                setupCanvas();
                startDetection();
              })
              .catch(err => console.warn("Autoplay prevented:", err));
          });
        } else {
          console.error('HLS not supported in this browser.');
        }
      } catch (error) {
        console.error('Failed to load HLS.js:', error);
      }
    };

    loadHlsAndSetupStream();

    return () => {
      // Cleanup HLS instance
      const video = videoRef.current;
      if (video && video.hlsInstance) {
        video.hlsInstance.destroy();
      }
      stopDetection();
    };
  }, []);

  const loadScript = (src) => {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) {
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  };

  const setupCanvas = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    
    if (!video || !canvas) return;

    // Wait for video metadata and setup canvas properly
    const updateCanvasSize = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        // Set canvas internal dimensions to match video resolution
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        
        // Set canvas display size to match video element size
        const rect = video.getBoundingClientRect();
        canvas.style.width = rect.width + 'px';
        canvas.style.height = rect.height + 'px';
        
        console.log('Canvas setup:', {
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          displayWidth: rect.width,
          displayHeight: rect.height,
          canvasWidth: canvas.width,
          canvasHeight: canvas.height
        });
      }
    };

    // Handle immediate setup if video is ready
    if (video.readyState >= 1) {
      updateCanvasSize();
    }

    // Also listen for metadata load events
    const handleLoadedMetadata = () => {
      setTimeout(updateCanvasSize, 100); // Small delay to ensure dimensions are set
    };

    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('resize', updateCanvasSize);

    // Cleanup function
    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('resize', updateCanvasSize);
    };
  };

  const detectObjects = async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const model = modelRef.current;

    if (!video || !canvas || !model || !video.videoWidth) return;

    const startTime = Date.now();
    const ctx = canvas.getContext('2d');

    try {
      // Run detection with higher input resolution
      const predictions = await model.detect(video, undefined, 0.4); // Lower threshold for more detections
      
      // Filter only persons (jamaah) with better filtering
      let jamaah = predictions.filter(pred => {
        if (pred.class !== 'person' || pred.score < 0.65) return false;
        
        const [x, y, width, height] = pred.bbox;
        const aspectRatio = width / height;
        const area = width * height;
        
        // Filter out bounding boxes that are too wide, too small, or have unrealistic aspect ratios
        return (
          width < video.videoWidth * 0.4 &&  // Max 40% of video width
          height < video.videoHeight * 0.8 && // Max 80% of video height
          width > 30 &&                       // Minimum width
          height > 50 &&                      // Minimum height
          aspectRatio < 2.5 &&                // Not too wide
          aspectRatio > 0.3 &&                // Not too tall
          area < (video.videoWidth * video.videoHeight * 0.15) // Max 15% of total area
        );
      });

      // Sort by confidence (highest first)
      jamaah.sort((a, b) => b.score - a.score);

      // Apply more aggressive NMS to remove overlapping detections
      jamaah = applyNMS(jamaah, 0.3);

      const processTime = Date.now() - startTime;

      // Get video display dimensions vs actual dimensions
      const videoRect = video.getBoundingClientRect();
      const scaleX = canvas.width / video.videoWidth;
      const scaleY = canvas.height / video.videoHeight;
      
      // Clear canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Draw bounding boxes with simplified labels
      jamaah.forEach((detection, index) => {
        const [x, y, width, height] = detection.bbox;
        const jamaahNumber = index + 1;

        // Apply scaling if needed
        const scaledX = x * scaleX;
        const scaledY = y * scaleY;
        const scaledWidth = width * scaleX;
        const scaledHeight = height * scaleY;

        // Draw bounding box with consistent green color
        ctx.strokeStyle = '#10B981'; // Green color
        ctx.lineWidth = 4;
        ctx.strokeRect(scaledX, scaledY, scaledWidth, scaledHeight);

        // Draw semi-transparent fill
        ctx.fillStyle = 'rgba(16, 185, 129, 0.2)';
        ctx.fillRect(scaledX, scaledY, scaledWidth, scaledHeight);

        // Draw background for label
        const labelText = `Jamaah ${jamaahNumber}`;
        const labelWidth = 120;
        ctx.fillStyle = 'rgba(16, 185, 129, 0.9)';
        ctx.fillRect(scaledX, scaledY - 35, labelWidth, 30);

        // Draw label text
        ctx.fillStyle = 'white';
        ctx.font = 'bold 16px Arial';
        ctx.textBaseline = 'middle';
        ctx.fillText(labelText, scaledX + 5, scaledY - 20);

        // Draw number badge
        ctx.fillStyle = '#DC2626'; // Red for badge
        ctx.beginPath();
        ctx.arc(scaledX + scaledWidth - 20, scaledY + 20, 15, 0, 2 * Math.PI);
        ctx.fill();

        // White border for badge
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Number text in badge
        ctx.fillStyle = 'white';
        ctx.font = 'bold 14px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(jamaahNumber, scaledX + scaledWidth - 20, scaledY + 20);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
      });

      // Update stats
      setJamaahCount(jamaah.length);
      setDetectionStats(prev => ({
        ...prev,
        processTime,
        isDetecting: true
      }));

      // Calculate FPS
      frameCountRef.current++;
      const now = Date.now();
      if (now - lastFpsTimeRef.current >= 1000) {
        setDetectionStats(prev => ({
          ...prev,
          fps: frameCountRef.current
        }));
        frameCountRef.current = 0;
        lastFpsTimeRef.current = now;
      }

    } catch (error) {
      console.error('Detection error:', error);
    }
  };

  // Non-Maximum Suppression to remove overlapping detections
  const applyNMS = (detections, iouThreshold = 0.3) => {
    if (detections.length === 0) return [];

    const result = [];
    const sorted = [...detections].sort((a, b) => b.score - a.score);

    while (sorted.length > 0) {
      const current = sorted.shift();
      
      // Additional size validation before adding to results
      const [x, y, width, height] = current.bbox;
      const aspectRatio = width / height;
      
      // Skip if bounding box is still too large or has bad aspect ratio
      if (width > 200 && aspectRatio > 1.8) {
        continue;
      }
      
      result.push(current);

      // Remove overlapping detections
      for (let i = sorted.length - 1; i >= 0; i--) {
        const iou = calculateIoU(current.bbox, sorted[i].bbox);
        if (iou > iouThreshold) {
          sorted.splice(i, 1);
        }
      }
    }

    return result;
  };

  // Calculate Intersection over Union
  const calculateIoU = (boxA, boxB) => {
    const [x1A, y1A, wA, hA] = boxA;
    const [x1B, y1B, wB, hB] = boxB;
    
    const x2A = x1A + wA;
    const y2A = y1A + hA;
    const x2B = x1B + wB;
    const y2B = y1B + hB;

    const xA = Math.max(x1A, x1B);
    const yA = Math.max(y1A, y1B);
    const xB = Math.min(x2A, x2B);
    const yB = Math.min(y2A, y2B);

    const interArea = Math.max(0, xB - xA) * Math.max(0, yB - yA);
    const boxAArea = wA * hA;
    const boxBArea = wB * hB;
    const unionArea = boxAArea + boxBArea - interArea;

    return unionArea > 0 ? interArea / unionArea : 0;
  };

  const startDetection = () => {
    if (detectionIntervalRef.current) return;
    
    console.log('🔍 Starting jamaah detection...');
    setDetectionStats(prev => ({ ...prev, isDetecting: true }));
    
    
    detectionIntervalRef.current = setInterval(detectObjects, 166);
  };

  const stopDetection = () => {
    if (detectionIntervalRef.current) {
      clearInterval(detectionIntervalRef.current);
      detectionIntervalRef.current = null;
    }
    
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    
    setDetectionStats(prev => ({ ...prev, isDetecting: false }));
    setJamaahCount(0);
  };

  const formatTime = (date) =>
    date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false });

  const formatDate = (date) => {
    const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
    const months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
      'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    const dayName = days[date.getDay()];
    const day = date.getDate();
    const month = months[date.getMonth()];
    const year = date.getFullYear();
    return `${dayName}, ${day} ${month} ${year}`;
  };

  const getHijriDate = () => "28 Muharram 1447 H";

  const prayerTimes = [
    { name: 'Subuh', time: '04:45' },
    { name: 'Terbit', time: '06:01' },
    { name: 'Dhuha', time: '06:30' },
    { name: 'Dzuhur', time: '12:03' },
    { name: 'Ashar', time: '15:24' },
    { name: 'Maghrib', time: '17:57' },
    { name: 'Isya', time: '19:09' }
  ];

  const getNextPrayer = () => {
    const currentMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();

    for (let prayer of prayerTimes) {
      const [h, m] = prayer.time.split(':').map(Number);
      const prayerMinutes = h * 60 + m;

      if (prayerMinutes > currentMinutes) {
        return prayer;
      }
    }

    return prayerTimes[0];
  };

  const nextPrayer = getNextPrayer();

  const calculateTimeUntilNext = () => {
    const now = new Date();
    const [hours, minutes] = nextPrayer.time.split(':');
    const nextPrayerTime = new Date();
    nextPrayerTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);
    if (nextPrayerTime <= now) nextPrayerTime.setDate(nextPrayerTime.getDate() + 1);
    const diff = nextPrayerTime - now;
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    return `${h}h ${m}m ${s}s`;
  };

  const backgroundStyle = {
    backgroundImage: `
      linear-gradient(135deg, rgba(255, 0, 0, 0.7), rgba(213, 46, 46, 0.7), rgba(144, 0, 255, 0.7)),
      url('/mosque-bg.jpg')
    `,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat'
  };

  return (
    <div className="min-h-screen flex" style={backgroundStyle}>
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="flex justify-between items-start p-6 text-white">
          <div className="text-left">
            <div className="text-lg font-medium">{formatDate(currentTime)}</div>
            <div className="text-base opacity-90">{getHijriDate()}</div>
          </div>
          <div className="text-center">
            <h1 className="text-3xl font-bold">Masjid Al Muqorrobin</h1>
          </div>
          <div className="text-right">
            <div className="text-4xl font-bold">{formatTime(currentTime)}</div>
            <div className="text-sm opacity-75">WIB</div>
          </div>
        </div>

        {/* Main Section */}
        <div className="flex-1 flex flex-col items-center justify-center text-white">
          <h2 className="text-6xl font-bold mb-6">Khotbah Jum'at</h2>
          <div className="text-5xl font-bold text-yellow-300 mb-4">H. ABDUL GHONI</div>
          <div className="text-3xl">Tema:</div>
          <div className="text-3xl italic opacity-90 mb-8">"Sucikan hati dan pikiran"</div>

          {/* Video with Detection Overlay */}
          <div className="mb-8 w-full flex justify-center">
            <div className="relative" style={{ width: '80%', maxWidth: '800px' }}>
              <video
                ref={videoRef}
                controls
                autoPlay
                muted
                className="rounded-xl shadow-lg bg-black w-full"
              />
              <canvas
                ref={canvasRef}
                className="absolute top-0 left-0 rounded-xl pointer-events-none"
                style={{ zIndex: 10 }}
              />
              
              {/* Jamaah Counter Overlay */}
              <div className="absolute top-4 left-4 bg-black bg-opacity-70 text-white px-4 py-2 rounded-lg">
                <div className="flex items-center space-x-2">
                  <span className="text-2xl">👥</span>
                  <div>
                    <div className="text-lg font-bold">Jamaah: {jamaahCount}</div>
                    <div className="text-xs opacity-75">
                      {detectionStats.isDetecting ? (
                        `${detectionStats.fps} FPS • ${detectionStats.processTime}ms`
                      ) : (
                        'Detection Stopped'
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Detection Controls */}
              <div className="absolute top-4 right-4 space-x-2">
                <button
                  onClick={startDetection}
                  className="bg-green-600 hover:bg-green-700 text-white px-3 py-1 rounded text-sm"
                  disabled={detectionStats.isDetecting}
                >
                  ▶️ Start
                </button>
                <button
                  onClick={stopDetection}
                  className="bg-red-600 hover:bg-red-700 text-white px-3 py-1 rounded text-sm"
                  disabled={!detectionStats.isDetecting}
                >
                  ⏹️ Stop
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-6 text-white text-center">
          <div className="text-xl font-medium">
            Jadwal Imam dan Khotib Sholat Jumat 08 Agustus 2025
          </div>
        </div>
      </div>

      {/* Sidebar */}
      <div className="w-80 bg-black bg-opacity-40 backdrop-blur-sm p-6 border-l border-white border-opacity-10">
        <div className="text-white space-y-4">
          {/* Jamaah Detection Stats */}
          <div className="mb-6 p-4 bg-green-600 bg-opacity-80 rounded-lg">
            <div className="text-center">
              <div className="text-2xl font-bold mb-2">🕌 Live Detection</div>
              <div className="text-3xl font-bold text-yellow-300 mb-2">{jamaahCount} Jamaah</div>
              <div className="text-sm space-y-1">
                <div>Status: {detectionStats.isDetecting ? '🟢 Active' : '🔴 Inactive'}</div>
                <div>FPS: {detectionStats.fps}</div>
                <div>Process: {detectionStats.processTime}ms</div>
              </div>
            </div>
          </div>

          {/* Prayer Times */}
          {prayerTimes.map((prayer, index) => (
            <div key={index} className="flex justify-between items-center py-2 px-4 rounded-lg bg-black bg-opacity-30">
              <span className="text-lg">{prayer.name}:</span>
              <span className="text-lg font-mono">{prayer.time}</span>
            </div>
          ))}
          
          <div className="mt-8 p-4 bg-green-600 rounded-lg text-center">
            <div className="text-sm opacity-90">Next: {nextPrayer.name}</div>
            <div className="text-xl font-bold">{calculateTimeUntilNext()}</div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MosquePrayerDisplay;