@echo on
cd /d "F:\KLAS\llamacpp"
set GGML_DEBUG=1

llama-server.exe ^
  -m "F:\KLAS\LLMs\LLAMACPP_MODELS\gemma-4-12b-it-UD-Q4_K_XL.gguf" ^
  -c 256000 ^
  -ngl 99 ^
  --flash-attn on ^
  -b 2048 -ub 1024 ^
  --jinja ^
  -np 1 --slots --cont-batching ^
  --temperature 0.6 ^
  --min-p 0.05 ^
  --repeat-penalty 1.2 ^
  --repeat-last-n 512 ^
  --frequency-penalty 0.15 ^
  --presence-penalty 0.2 ^
  --reasoning off ^
  --cache-ram 0
pause