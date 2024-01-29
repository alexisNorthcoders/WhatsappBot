function read_file(filename)
    local f = io.open(filename, 'r')
    
    if f ~= nil then
    io.input(f)
    local content = io.read() -- Make sure to read the entire file content
    io.close(f)
    
    return content
    end
    end
    
    function press(button)
    local input_table = {}
    input_table[button] = true
    joypad.set(1, input_table)
    
    end
    
    while true do
    local button = read_file('button.txt')
    
    if button ~= nil then
    press(button)
    emu.message('Pressing: ' .. button)
    
    os.remove('button.txt')
    end
    
    emu.frameadvance()
    end