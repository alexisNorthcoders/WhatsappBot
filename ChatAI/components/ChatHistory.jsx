import React, { useEffect, useState, useRef } from "react";
import Markdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { dracula } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Card, Container } from 'react-bootstrap';

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
    const response = await fetch("/gpt4", {
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
    <Container >
      {history.length > 1 &&
        history.slice(0, -1).map((conversation, index) => (
          <Card bg="light"className="history" key={index}>
            <Card.Body >
              <Card.Header as="h6">User:</Card.Header>
              <Card.Text as="p">{conversation.user}</Card.Text>
              <Card.Header as="h6">Bot:</Card.Header>
              <Card.Text as="p"> {conversation.bot}</Card.Text>
            </Card.Body>
          </Card>
        ))}
      {submit ? (
        <Card className="current-pair">
          <Card.Body>
             <Card.Header as="h6">User:</Card.Header>
             <Card.Text as="p">{submit}</Card.Text>
             <Card.Header as="h6">Bot:</Card.Header>
             <Card.Text as="p">
             <Markdown
                children={messages}
                components={{
                  code(props) {
                    const { children, className, node, ...rest } = props;
                    const match = /language-(\w+)/.exec(className || "");
                    return match ? (
                      <SyntaxHighlighter
                        {...rest}
                        PreTag="div"
                        children={String(children).replace(/\n$/, "")}
                        language={match[1]}
                        style={dracula}
                      />
                    ) : (
                      <code {...rest} className={className}>
                        {children}
                      </code>
                    );
                  },
                }}
              />
            </Card.Text>
          </Card.Body>
        </Card>
      ) : null}
      <div ref={bottomRef} />
      </Container>
  );
}
