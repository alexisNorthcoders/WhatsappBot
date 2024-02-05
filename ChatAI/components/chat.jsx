import React, { useState } from "react";
import ChatHistory from "./ChatHistory";
import Input from "./Input";


export default function Home() {
  const [submit, setSubmit] = useState("");
  const [inputValue, setInputValue] = useState("");
  const [readingStream, setReadingStream] = useState(true);

  
return (<>
    
     <ChatHistory setReadingStream={setReadingStream} readingStream={readingStream} inputValue={inputValue} submit={submit}/>
     <Input setReadingStream={setReadingStream} submit={submit} setSubmit={setSubmit} setInputValue={setInputValue} inputValue={inputValue}/>
    
    </>
  );
}
