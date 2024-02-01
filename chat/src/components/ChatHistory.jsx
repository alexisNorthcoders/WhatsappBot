import React, { useEffect, useState, useRef } from "react";
import Markdown from 'react-markdown'
import {Prism as SyntaxHighlighter} from 'react-syntax-highlighter'
import {dracula} from 'react-syntax-highlighter/dist/esm/styles/prism'

export default function ChatHistory({
  submit,
  readingStream,
  setReadingStream,
}) {
  const [messages, setMessages] = useState("");
  const [history, setHistory] = useState([]);
  const bottomRef = useRef(null);
  
  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const fetchData = async (submitValue) => {
    setMessages("");
    const response = await fetch("http://localhost:8080/gpt4", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userPrompt: submitValue }),
    });
    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .getReader();

    let conversation = "";

    const updateStream = async () => {
      
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          setReadingStream(false);
          break;
        }
        
        conversation += value;

        setMessages((prev) => {
          setTimeout(scrollToBottom, 0);
          return prev + value; 
        });
      }
      setHistory((prevMessages) => [
        ...prevMessages,
        { user: submit, bot: conversation },
      ]);
    };

    updateStream();
  };

  useEffect(() => {
    if (submit && readingStream) {
      fetchData(submit);
    }
  }, [submit, readingStream]);


  return (
    <div id="chat-history">
      {history.length > 1 &&
        history.slice(0, -1).map((conversation, index) => (
          <div key={index} id="conversation-pair">
            <p>User: {conversation.user}</p>
            <p>Bot: {conversation.bot}</p>
          </div>
        ))}
      {submit ? (
        <div id="current-pair">
          <p>User: {submit}</p>
          <p>Bot:<Markdown
    children={messages}
    components={{
      code(props) {
        const {children, className, node, ...rest} = props
        const match = /language-(\w+)/.exec(className || '')
        return match ? (
          <SyntaxHighlighter
            {...rest}
            PreTag="div"
            children={String(children).replace(/\n$/, '')}
            language={match[1]}
            style={dracula}
          />
        ) : (
          <code {...rest} className={className}>
            {children}
          </code>
        )
      }
    }}
  /></p>
        </div>
      ) : null}
      <div ref={bottomRef} />
    </div>
  );
}
