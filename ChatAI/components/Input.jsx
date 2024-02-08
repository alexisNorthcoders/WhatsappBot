import { useState } from "react";
import { Container,Form,FormControl,Button } from "react-bootstrap";

export default function Input({setSubmit,setReadingStream}) {
  const [inputValue, setInputValue] = useState("");

  const handleInputChange = (e) => {
    setInputValue(e.target.value);
  };
  const handleClick = (event) => {
    event.preventDefault()
    setReadingStream(true)
    setSubmit(inputValue)

    setInputValue("")
  };

  return (
    <Container>
    <Form onSubmit={handleClick}>
      <FormControl
        as="textarea"
        placeholder="Enter text here"
        value={inputValue}
        onChange={handleInputChange}
        className="input-box"
      />
      <Button type="submit" className="submit-button">
        Send
      </Button>
    </Form>
    </Container>
  );
}
