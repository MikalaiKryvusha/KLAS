# Test GPU detection by llama-server
$process = Start-Process -FilePath "f:\KLAS\llamacpp\llama-server.exe" `
  -ArgumentList "-m", "F:\LLMs\LLAMACPP_MODELS\Qwen2.5-Coder-14B-Instruct-Q5_K_M.gguf", `
  "--port", "12345", "-ngl", "99", "-c", "20480", `
  "-ngl", "99", "--verbose" `
  -NoNewWindow -Wait -PassThru

Write-Host "Exit code: $($process.ExitCode)"
